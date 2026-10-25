package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// JSON/JavaScript 共同精确表示的非负整数范围；不乘天数，避免期限溢出。
const maxRetentionDays = 1<<53 - 1

func trashRetentionDays(settings map[string]json.RawMessage) (int64, error) {
	raw, ok := settings["trashRetentionDays"]
	if !ok || bytes.Equal(raw, []byte("null")) {
		return 30, nil
	}
	var days int64
	if err := json.Unmarshal(raw, &days); err != nil || days < 0 || days > maxRetentionDays {
		return 0, fmt.Errorf("回收站保留天数必须为非负安全整数，0 表示永不自动删除")
	}
	return days, nil
}

func (s *Server) trashClear(w http.ResponseWriter, r *http.Request) {
	result, err := s.vault.PurgeTrash(0, time.Now())
	if err != nil {
		internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) cleanupTrash(now time.Time) error {
	s.activity.RLock()
	defer s.activity.RUnlock()
	// 与设置写入串行，避免在“永不删除”已保存后使用旧期限开始清理。
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	settings, err := s.readSettings()
	if err != nil {
		return err
	}
	days, err := trashRetentionDays(settings)
	if err != nil || days == 0 {
		return err
	}
	result, err := s.vault.PurgeTrash(days, now)
	if err != nil {
		return err
	}
	if len(result.Failed) > 0 {
		return fmt.Errorf("回收站清理部分失败: %v", result.Failed)
	}
	if len(result.Deleted) > 0 {
		slog.Info("已清理过期回收站条目", "count", len(result.Deleted))
	}
	return nil
}

// RunTrashCleanup 启动时执行一次，其后每小时执行；不依赖浏览器在线。
func (s *Server) RunTrashCleanup(ctx context.Context) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		if err := s.cleanupTrash(time.Now()); err != nil {
			slog.Error("自动清理回收站失败", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
