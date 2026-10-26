package api

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"rawmark/internal/i18n"
	"runtime"
	"strings"
	"syscall"
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
	cause      error
}

// gate drains ordinary API operations before maintenance; WebSockets do not hold long-lived read locks.
func (s *Server) guardAPI(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api/v1/health" {
			next.ServeHTTP(w, r)
			return
		}
		if s.maintenanceBusy.Load() && r.URL.Path != "/api/v1/maintenance/status" {
			writeError(w, 503, message(w, "maintenance_is_in_progress_please_64ef9d"))
			return
		}
		resourcePath, resource := strings.CutPrefix(r.URL.Path, "/api/v1/resources/")
		_, resourceTail, hasTicket := strings.Cut(resourcePath, "/")
		eventResource := resource && hasTicket && resourceTail == "events/"
		if strings.HasPrefix(r.URL.Path, "/api/v1/maintenance/") || r.URL.Path == "/api/v1/events" || eventResource {
			next.ServeHTTP(w, r)
			return
		}
		if !s.activity.TryRLock() {
			writeError(w, 503, message(w, "maintenance_is_in_progress_please_64ef9d"))
			return
		}
		defer s.activity.RUnlock()
		next.ServeHTTP(w, r)
	})
}

var errMaintenanceBusy = i18n.New("another_maintenance_operation_is_in_da1aa4")
var errMaintenanceInput = i18n.New("invalid_maintenance_request_ef9c16")

func (s *Server) maintain(operation string, fn func() error) error {
	if !s.maintenanceMu.TryLock() {
		return errMaintenanceBusy
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
		s.maintenanceState.cause = err
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
	state := s.maintenanceState
	if state.Operation != "" {
		state.Operation = message(w, state.Operation)
	}
	if state.cause != nil {
		state.Error = i18n.RenderError(state.cause, responseLocale(w))
	}
	writeJSON(w, 200, state)
}
func (s *Server) maintenanceError(w http.ResponseWriter, r *http.Request, err error) {
	var pathError *os.PathError
	switch {
	case errors.Is(err, errMaintenanceBusy):
		writeError(w, 503, i18n.RenderError(err, responseLocale(w)))
	case errors.Is(err, syscall.ENOSPC):
		writeError(w, 503, message(w, "not_enough_disk_space_a53a70"))
	case errors.As(err, &pathError) && !errors.Is(pathError, os.ErrNotExist) && !errors.Is(pathError, syscall.ENOTDIR) && !errors.Is(pathError, syscall.EISDIR):
		internalError(w, r, err)
	case errors.Is(err, errMaintenanceInput), errors.Is(err, backup.ErrInvalidArchive):
		writeError(w, 400, message(w, "operation_failed", i18n.RenderError(err, responseLocale(w))))
	default:
		internalError(w, r, err)
	}
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
		writeError(w, 400, message(w, "invalid_backup_type_f5ff70"))
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
	err = s.maintain("export_backup_e9d3dd", func() error {
		if err := s.createArchive(r.Context(), kind, name); err != nil {
			return err
		}
		return sendDownload(w, r, name, "rawmark-"+kind+"-"+time.Now().Format("20060102-150405")+".zip")
	})
	if err != nil {
		s.maintenanceError(w, r, err)
	}
}
func (s *Server) exportNotes(w http.ResponseWriter, r *http.Request) {
	err := s.maintain("export_note_data_45a4e1", func() error {
		dataRoot, err := filepath.EvalSymlinks(s.DataDir)
		if err != nil {
			return err
		}
		file, err := s.vault.ExportNotes(r.Context(), func(rel string) bool {
			return backup.VaultExcluded(dataRoot, s.vault.Root(), rel)
		})
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
		s.maintenanceError(w, r, err)
	}
}

func validatePreferences(values map[string]json.RawMessage) error {
	for key, raw := range values {
		if len(raw) > maxJSONBytes {
			return i18n.New("w_a_single_setting_exceeds_c7dccb", errMaintenanceInput)
		}
		switch {
		case key == settingsKey:
			var settings map[string]json.RawMessage
			if err := json.Unmarshal(raw, &settings); err != nil || settings == nil {
				return i18n.New("w_preferences_must_be_an_8d2724", errMaintenanceInput)
			}
			if err := validateLocale(settings); err != nil {
				return errors.Join(errMaintenanceInput, err)
			}
			if _, err := trashRetentionDays(settings); err != nil {
				return i18n.New("w_w_f0fd7d", errMaintenanceInput, err)
			}
			if value, ok := settings["shortcuts"]; ok {
				var shortcuts map[string][]string
				if err := json.Unmarshal(value, &shortcuts); err != nil {
					return i18n.New("w_invalid_shortcut_format_0acab4", errMaintenanceInput)
				}
			}
		case key == pluginEnabledKey:
			var ids map[string]bool
			if err := json.Unmarshal(raw, &ids); err != nil {
				return i18n.New("w_w_f0fd7d", errMaintenanceInput, err)
			}
			for id := range ids {
				if !validPluginID(id) {
					return i18n.New("w_invalid_plugin_id_7f3512", errMaintenanceInput)
				}
			}
		case strings.HasPrefix(key, "plugin.data."):
			if !validPluginID(strings.TrimPrefix(key, "plugin.data.")) || !json.Valid(raw) {
				return i18n.New("w_invalid_plugin_data_1f5fe3", errMaintenanceInput)
			}
		default:
			return i18n.New("w_the_settings_package_contains_e70b59", errMaintenanceInput)
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
		return nil, i18n.New("w_settings_package_content_exceeds_baf8eb", errMaintenanceInput)
	}
	raw, err := os.ReadFile(filepath.Join(stage, "settings.json"))
	if err != nil {
		return nil, err
	}
	var values map[string]json.RawMessage
	if err = json.Unmarshal(raw, &values); err != nil || values == nil {
		return nil, i18n.New("w_invalid_settings_package_format_2e7bee", errMaintenanceInput)
	}
	if err = validatePreferences(values); err != nil {
		return nil, err
	}
	return values, nil
}

// importSettings merges resources after confirmation, retaining original resources and database values until commit succeeds.
func (s *Server) applySettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID        string
		Confirmed bool
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !body.Confirmed {
		writeError(w, 400, message(w, "confirm_settings_import_first_e89aa3"))
		return
	}
	err := s.maintain("import_settings_1a80d4", func() error {
		meta, dir, err := s.readUpload(r, body.ID)
		if err != nil {
			return err
		}
		if !meta.Validated || meta.Kind != "settings" {
			return i18n.New("w_validate_the_settings_package_0f4f56", errMaintenanceInput)
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
		s.maintenanceError(w, r, err)
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
		writeError(w, 400, message(w, "confirm_reset_first_22ae3d"))
		return
	}
	err := s.maintain("reset_settings_9a70ef", func() error {
		if _, err := s.saveRollback(r.Context(), "settings"); err != nil {
			return err
		}
		if err := s.store.ResetPreferences(); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		s.maintenanceError(w, r, err)
		return
	}
	s.hub.Broadcast(events.Event{Type: "settings"}, events.Event{Type: "plugins"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) maintainIndex(w http.ResponseWriter, r *http.Request) {
	operation := r.PathValue("operation")
	if operation != "optimize" && operation != "rebuild" {
		writeError(w, 400, message(w, "invalid_index_operation_be898b"))
		return
	}
	err := s.maintain("index_maintenance_676706", func() error {
		if operation == "rebuild" {
			return s.index.Rebuild(r.Context())
		}
		return s.index.Optimize(r.Context())
	})
	if err != nil {
		s.maintenanceError(w, r, err)
		return
	}
	s.hub.Broadcast(events.Event{Type: "indexed"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) exportLogs(w http.ResponseWriter, r *http.Request) {
	if s.Logs == nil {
		writeError(w, 503, message(w, "log_files_are_not_enabled_dcf4df"))
		return
	}
	err := s.maintain("export_system_logs_d05855", func() error {
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
		s.maintenanceError(w, r, err)
	}
}
