package api

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"rawmark/internal/backup"
	"rawmark/internal/events"
)

type maintenanceStatus struct {
	Busy       bool   `json:"busy"`
	Operation  string `json:"operation"`
	Error      string `json:"error"`
	FinishedAt int64  `json:"finishedAt"`
	Backup     string `json:"backup,omitempty"`
}

// gate 排空普通 API 操作后再执行维护；WebSocket 不持有长期读锁。
func (s *Server) guardAPI(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api/v1/health" {
			next.ServeHTTP(w, r)
			return
		}
		if s.maintenanceBusy.Load() && r.URL.Path != "/api/v1/maintenance/status" {
			writeError(w, 503, "正在维护，请稍后重试")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/maintenance/") || r.URL.Path == "/api/v1/events" {
			next.ServeHTTP(w, r)
			return
		}
		if !s.activity.TryRLock() {
			writeError(w, 503, "正在维护，请稍后重试")
			return
		}
		defer s.activity.RUnlock()
		next.ServeHTTP(w, r)
	})
}
func (s *Server) maintain(operation string, fn func() error) error {
	if !s.maintenanceMu.TryLock() {
		return fmt.Errorf("其他维护操作正在执行")
	}
	defer s.maintenanceMu.Unlock()
	s.maintenanceBusy.Store(true)
	s.maintenanceStatusMu.Lock()
	s.maintenanceState = maintenanceStatus{Busy: true, Operation: operation}
	s.maintenanceStatusMu.Unlock()
	s.activity.Lock()
	defer s.activity.Unlock()
	err := fn()
	s.maintenanceStatusMu.Lock()
	s.maintenanceState.Busy = false
	s.maintenanceState.FinishedAt = time.Now().UnixMilli()
	if err != nil {
		s.maintenanceState.Error = err.Error()
	}
	s.maintenanceStatusMu.Unlock()
	if !s.restarting.Load() {
		s.maintenanceBusy.Store(false)
	}
	return err
}
func (s *Server) maintenanceInfo(w http.ResponseWriter, r *http.Request) {
	s.maintenanceStatusMu.Lock()
	defer s.maintenanceStatusMu.Unlock()
	writeJSON(w, 200, s.maintenanceState)
}
func (s *Server) maintenanceError(w http.ResponseWriter, err error) {
	writeError(w, 400, "操作失败："+err.Error())
}
func (s *Server) tempDir() (string, error) {
	dir := filepath.Join(s.DataDir, "temp")
	return dir, os.MkdirAll(dir, 0700)
}
func (s *Server) backupDir() (string, error) {
	dir := filepath.Join(s.DataDir, "backups")
	return dir, os.MkdirAll(dir, 0700)
}
func (s *Server) archiveSources(ctx context.Context, stage, kind string) ([]backup.Source, error) {
	sources := []backup.Source{}
	if kind == "full" {
		snapshot := filepath.Join(stage, "rawmark.db")
		if err := s.store.Snapshot(ctx, snapshot); err != nil {
			return nil, err
		}
		sources = append(sources, backup.Source{Name: "app/rawmark.db", Path: snapshot}, backup.Source{Name: "vault", Path: s.vault.Root()})
	} else {
		prefs, err := s.store.Preferences()
		if err != nil {
			return nil, err
		}
		data, err := json.Marshal(prefs)
		if err != nil {
			return nil, err
		}
		file := filepath.Join(stage, "settings.json")
		if err = os.WriteFile(file, data, 0600); err != nil {
			return nil, err
		}
		sources = append(sources, backup.Source{Name: "settings.json", Path: file})
	}
	for _, name := range []string{"fonts", "themes", "plugins"} {
		root := filepath.Join(s.DataDir, name)
		_, err := os.Stat(root)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		sources = append(sources, backup.Source{Name: "app/" + name, Path: root})
	}
	return sources, nil
}
func (s *Server) createArchive(ctx context.Context, kind, dest string) error {
	temp, err := s.tempDir()
	if err != nil {
		return err
	}
	stage, err := os.MkdirTemp(temp, "backup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	sources, err := s.archiveSources(ctx, stage, kind)
	if err != nil {
		return err
	}
	return backup.Create(ctx, dest, kind, sources, func(name string) bool {
		if strings.HasPrefix(name, "vault/") {
			return backup.VaultExcluded(s.DataDir, s.vault.Root(), strings.TrimPrefix(name, "vault/"))
		}
		for _, part := range strings.Split(name, "/") {
			if strings.HasPrefix(part, ".import-") || strings.HasPrefix(part, ".install-") {
				return true
			}
		}
		return false
	})
}
func (s *Server) saveRollback(ctx context.Context, kind string) (string, error) {
	dir, err := s.backupDir()
	if err != nil {
		return "", err
	}
	file := filepath.Join(dir, kind+"-"+time.Now().Format("20060102T150405.000000000")+".zip")
	if err = s.createArchive(ctx, kind, file); err != nil {
		return "", err
	}
	s.maintenanceStatusMu.Lock()
	s.maintenanceState.Backup = filepath.Base(file)
	s.maintenanceStatusMu.Unlock()
	return file, nil
}
func sendDownload(w http.ResponseWriter, r *http.Request, file, name string) error {
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	http.ServeContent(w, r, name, time.Time{}, f)
	return nil
}
func (s *Server) exportBackup(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	if kind != "full" && kind != "settings" {
		writeError(w, 400, "备份类型无效")
		return
	}
	temp, err := s.tempDir()
	if err != nil {
		internalError(w, r, err)
		return
	}
	file, err := os.CreateTemp(temp, "download-*.zip")
	if err != nil {
		internalError(w, r, err)
		return
	}
	name := file.Name()
	file.Close()
	os.Remove(name)
	defer os.Remove(name)
	err = s.maintain("导出备份", func() error {
		if err := s.createArchive(r.Context(), kind, name); err != nil {
			return err
		}
		return sendDownload(w, r, name, "rawmark-"+kind+"-"+time.Now().Format("20060102-150405")+".zip")
	})
	if err != nil {
		s.maintenanceError(w, err)
	}
}
func (s *Server) exportNotes(w http.ResponseWriter, r *http.Request) {
	err := s.maintain("导出笔记数据", func() error {
		file, err := s.vault.ExportNotes(r.Context())
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		if err = file.Close(); err != nil {
			return err
		}
		return sendDownload(w, r, file.Name(), "rawmark-notes-"+time.Now().Format("20060102-150405")+".zip")
	})
	if err != nil {
		s.maintenanceError(w, err)
	}
}

func validatePreferences(values map[string]json.RawMessage) error {
	for key, raw := range values {
		if len(raw) > maxJSONBytes {
			return fmt.Errorf("单项设置超过 1 MiB")
		}
		switch {
		case key == settingsKey:
			var settings map[string]json.RawMessage
			if err := json.Unmarshal(raw, &settings); err != nil || settings == nil {
				return fmt.Errorf("偏好设置必须为对象")
			}
			if _, err := trashRetentionDays(settings); err != nil {
				return err
			}
			if value, ok := settings["shortcuts"]; ok {
				var shortcuts map[string][]string
				if err := json.Unmarshal(value, &shortcuts); err != nil {
					return fmt.Errorf("快捷键格式无效")
				}
			}
		case key == pluginEnabledKey:
			var ids map[string]bool
			if err := json.Unmarshal(raw, &ids); err != nil {
				return err
			}
			for id := range ids {
				if !validPluginID(id) {
					return fmt.Errorf("插件 ID 无效")
				}
			}
		case strings.HasPrefix(key, "plugin.data."):
			if !validPluginID(strings.TrimPrefix(key, "plugin.data.")) || !json.Valid(raw) {
				return fmt.Errorf("插件数据无效")
			}
		default:
			return fmt.Errorf("设置包包含不允许的设置项")
		}
	}
	return nil
}
func readPreferences(stage string) (map[string]json.RawMessage, error) {
	info, err := os.Stat(filepath.Join(stage, "settings.json"))
	if err != nil {
		return nil, err
	}
	if info.Size() > 32<<20 {
		return nil, fmt.Errorf("设置包设置内容超过 32 MiB")
	}
	raw, err := os.ReadFile(filepath.Join(stage, "settings.json"))
	if err != nil {
		return nil, err
	}
	var values map[string]json.RawMessage
	if err = json.Unmarshal(raw, &values); err != nil || values == nil {
		return nil, fmt.Errorf("设置包格式无效")
	}
	if err = validatePreferences(values); err != nil {
		return nil, err
	}
	return values, nil
}

// importSettings 在确认后合并资源；原资源与数据库值都保留到成功提交为止。
func (s *Server) applySettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID        string
		Confirmed bool
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !body.Confirmed {
		writeError(w, 400, "请先确认导入设置")
		return
	}
	err := s.maintain("导入设置", func() error {
		meta, dir, err := s.readUpload(r, body.ID)
		if err != nil {
			return err
		}
		if !meta.Validated || meta.Kind != "settings" {
			return fmt.Errorf("请先校验设置包")
		}
		stage := filepath.Join(dir, "stage")
		values, err := readPreferences(stage)
		if err != nil {
			return err
		}
		rollbackArchive, err := s.saveRollback(r.Context(), "settings")
		if err != nil {
			return err
		}
		original, err := s.store.Preferences()
		if err != nil {
			return err
		}
		temp, err := s.tempDir()
		if err != nil {
			return err
		}
		rollback, err := os.MkdirTemp(temp, "settings-rollback-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(rollback)
		type resource struct {
			target, old string
			existed     bool
		}
		var changed []resource
		restore := func() error {
			var failures []error
			for i := len(changed) - 1; i >= 0; i-- {
				item := changed[i]
				failures = append(failures, os.RemoveAll(item.target))
				if item.existed {
					failures = append(failures, os.Rename(item.old, item.target))
				}
			}
			failures = append(failures, s.store.ReplacePreferences(original))
			failure := errors.Join(failures...)
			if failure == nil {
				return backup.RemoveRecord(s.DataDir)
			}
			return failure
		}
		if err = backup.WriteRecord(s.DataDir, backup.RestoreRecord{State: "applying", Kind: "settings", Stage: stage, Backup: rollbackArchive}); err != nil {
			return err
		}
		for _, kind := range []string{"fonts", "themes", "plugins"} {
			source := filepath.Join(stage, "app", kind)
			entries, e := os.ReadDir(source)
			if errors.Is(e, os.ErrNotExist) {
				continue
			}
			if e != nil {
				return errors.Join(e, restore())
			}
			if e = os.MkdirAll(filepath.Join(s.DataDir, kind), 0700); e != nil {
				return errors.Join(e, restore())
			}
			for _, entry := range entries {
				target := filepath.Join(s.DataDir, kind, entry.Name())
				old := filepath.Join(rollback, kind, entry.Name())
				if e = os.MkdirAll(filepath.Dir(old), 0700); e != nil {
					return errors.Join(e, restore())
				}
				existed := false
				if _, e = os.Lstat(target); e == nil {
					existed = true
					if e = os.Rename(target, old); e != nil {
						return errors.Join(e, restore())
					}
				} else if !errors.Is(e, os.ErrNotExist) {
					return errors.Join(e, restore())
				}
				changed = append(changed, resource{target, old, existed})
				if e = backup.CopyTree(filepath.Join(source, entry.Name()), target); e != nil {
					return errors.Join(e, restore())
				}
			}
		}
		if err = s.store.ReplacePreferences(values); err != nil {
			return errors.Join(err, restore())
		}
		if err = os.RemoveAll(dir); err != nil {
			return errors.Join(err, restore())
		}
		if err = backup.RemoveRecord(s.DataDir); err != nil {
			return errors.Join(err, restore())
		}
		return nil
	})
	if err != nil {
		s.maintenanceError(w, err)
		return
	}
	s.hub.Broadcast(events.Event{Type: "settings"}, events.Event{Type: "plugins"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) resetSettings(w http.ResponseWriter, r *http.Request) {
	var body struct{ Confirmed bool }
	if !readJSON(w, r, &body) {
		return
	}
	if !body.Confirmed {
		writeError(w, 400, "请先确认重置")
		return
	}
	err := s.maintain("重置设置", func() error {
		if _, err := s.saveRollback(r.Context(), "settings"); err != nil {
			return err
		}
		if err := s.store.ResetPreferences(); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		s.maintenanceError(w, err)
		return
	}
	s.hub.Broadcast(events.Event{Type: "settings"}, events.Event{Type: "plugins"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) maintainIndex(w http.ResponseWriter, r *http.Request) {
	operation := r.PathValue("operation")
	if operation != "optimize" && operation != "rebuild" {
		writeError(w, 400, "索引操作无效")
		return
	}
	err := s.maintain("索引维护", func() error {
		if operation == "rebuild" {
			return s.index.Rebuild(r.Context())
		}
		return s.index.Optimize(r.Context())
	})
	if err != nil {
		s.maintenanceError(w, err)
		return
	}
	s.hub.Broadcast(events.Event{Type: "indexed"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) exportLogs(w http.ResponseWriter, r *http.Request) {
	if s.Logs == nil {
		writeError(w, 503, "当前服务尚未启用日志文件")
		return
	}
	err := s.maintain("导出系统日志", func() error {
		temp, err := s.tempDir()
		if err != nil {
			return err
		}
		dir, err := os.MkdirTemp(temp, "logs-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		if err = s.Logs.Snapshot(dir); err != nil {
			return err
		}
		file := filepath.Join(dir, "system-logs.zip")
		out, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		z := zip.NewWriter(out)
		entries, err := os.ReadDir(dir)
		if err != nil {
			out.Close()
			return err
		}
		for _, entry := range entries {
			if !strings.HasPrefix(entry.Name(), "rawmark.log") {
				continue
			}
			dest, e := z.Create(entry.Name())
			if e != nil {
				out.Close()
				return e
			}
			in, e := os.Open(filepath.Join(dir, entry.Name()))
			if e != nil {
				out.Close()
				return e
			}
			_, e = io.Copy(dest, in)
			e = errors.Join(e, in.Close())
			if e != nil {
				out.Close()
				return e
			}
		}
		dest, err := z.Create("runtime.json")
		if err == nil {
			err = json.NewEncoder(dest).Encode(map[string]string{"go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH, "version": s.Version})
		}
		err = errors.Join(err, z.Close(), out.Close())
		if err != nil {
			return err
		}
		return sendDownload(w, r, file, "rawmark-system-logs.zip")
	})
	if err != nil {
		s.maintenanceError(w, err)
	}
}
