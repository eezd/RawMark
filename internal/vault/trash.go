package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// 调用方持有写锁并已读取验证元数据。先删除内容，失败时保留条目的管理依据。
func (v *Vault) purgeTrashItemLocked(metadata trashMetadata) error {
	dir := filepath.Join(v.trash, metadata.ID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "meta.json" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return err
		}
	}
	metaPath := filepath.Join(dir, "meta.json")
	if err := os.Remove(metaPath); err != nil {
		return err
	}
	if err := os.Remove(dir); err != nil {
		// 父目录不可写等原因仍可能阻止最后的 rmdir，恢复元数据以便继续清理。
		data, _ := json.Marshal(metadata)
		return errors.Join(err, atomicWrite(metaPath, data))
	}
	return nil
}

type TrashFailure struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

type TrashPurgeResult struct {
	Deleted []string       `json:"deleted"`
	Failed  []TrashFailure `json:"failed"`
}

// PurgeTrash 在与恢复相同的写锁内读取元数据并清理。days=0 清空所有；
// 自动清理的“永不删除”由调用方处理，不调用本方法。
func (v *Vault) PurgeTrash(days int64, now time.Time) (TrashPurgeResult, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	result := TrashPurgeResult{Deleted: []string{}, Failed: []TrashFailure{}}
	if days < 0 {
		return result, fmt.Errorf("保留天数不能为负数")
	}
	dirs, err := os.ReadDir(v.trash)
	if err != nil {
		return result, err
	}
	for _, dir := range dirs {
		id := dir.Name()
		if !trashIDPattern.MatchString(id) {
			continue // 不删除非本程序管理的文件。
		}
		metadata, err := v.readTrashMetadata(id)
		if err == nil && days > 0 && (metadata.DeletedAt > now.UnixMilli() || (now.UnixMilli()-metadata.DeletedAt)/int64(24*time.Hour/time.Millisecond) < days) {
			continue
		}
		if err == nil {
			err = v.purgeTrashItemLocked(metadata)
		}
		if err != nil {
			result.Failed = append(result.Failed, TrashFailure{ID: id, Error: err.Error()})
		} else {
			result.Deleted = append(result.Deleted, id)
		}
	}
	return result, nil
}
