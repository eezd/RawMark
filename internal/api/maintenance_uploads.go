package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"rawmark/internal/fileutil"
	"rawmark/internal/i18n"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"rawmark/internal/backup"
	"rawmark/internal/store"

	"modernc.org/sqlite"
)

const maintenanceChunkBytes int64 = 8 << 20

var uploadIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

type maintenanceUpload struct {
	Kind      string `json:"kind"`
	Size      int64  `json:"size"`
	Owner     string `json:"owner"`
	Validated bool   `json:"validated"`
}

func uploadOwner(r *http.Request) string {
	return identity(r).SessionHash
}
func (s *Server) readUpload(r *http.Request, id string) (maintenanceUpload, string, error) {
	var meta maintenanceUpload
	if !uploadIDPattern.MatchString(id) {
		return meta, "", i18n.New("w_invalid_upload_id_23d358", errMaintenanceInput)
	}
	dir := filepath.Join(s.DataDir, ".maintenance", "uploads", id)
	data, err := os.ReadFile(filepath.Join(dir, "upload.json"))
	if errors.Is(err, os.ErrNotExist) {
		return meta, "", i18n.New("w_upload_does_not_exist_918d8d", errMaintenanceInput)
	}
	if err != nil {
		return meta, "", err
	}
	if err = json.Unmarshal(data, &meta); err != nil {
		return meta, "", err
	}
	if meta.Owner != uploadOwner(r) {
		return meta, "", i18n.New("w_upload_does_not_belong_c4d06d", errMaintenanceInput)
	}
	return meta, dir, nil
}
func saveUpload(dir string, meta maintenanceUpload) error {
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "upload.json"), data, 0600)
}
func enoughSpace(dir string, size int64) error {
	available, err := fileutil.AvailableBytes(dir)
	if err != nil {
		return err
	}
	if size < 0 || uint64(size)+(32<<20) > available {
		return i18n.New("not_enough_disk_space_w_a39b20", syscall.ENOSPC)
	}
	return nil
}
func (s *Server) startMaintenanceUpload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind string
		Size int64
	}
	if !readJSON(w, r, &body) {
		return
	}
	if (body.Kind != "full" && body.Kind != "settings") || body.Size <= 0 || body.Size > backup.MaxArchiveBytes {
		writeError(w, 400, message(w, "choose_a_valid_backup_with_51ba41"))
		return
	}
	var id string
	err := s.maintain("prepare_upload_ed0bd9", func() error {
		root := filepath.Join(s.DataDir, ".maintenance", "uploads")
		if err := os.MkdirAll(root, 0700); err != nil {
			return err
		}
		if err := enoughSpace(root, body.Size); err != nil {
			return err
		}
		id = hex.EncodeToString(randBytes())
		dir := filepath.Join(root, id)
		if err := os.Mkdir(dir, 0700); err != nil {
			return err
		}
		if err := saveUpload(dir, maintenanceUpload{Kind: body.Kind, Size: body.Size, Owner: uploadOwner(r)}); err != nil {
			os.RemoveAll(dir)
			return err
		}
		f, err := os.OpenFile(filepath.Join(dir, "archive.zip"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			os.RemoveAll(dir)
			return err
		}
		return f.Close()
	})
	if err != nil {
		s.maintenanceError(w, r, err)
		return
	}
	writeJSON(w, 201, map[string]string{"id": id})
}
func randBytes() []byte { bytes := make([]byte, 16); rand.Read(bytes); return bytes }
func (s *Server) appendMaintenanceUpload(w http.ResponseWriter, r *http.Request) {
	offset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
	if err != nil || offset < 0 {
		writeError(w, 400, message(w, "invalid_upload_offset_3bdbf1"))
		return
	}
	var next int64
	err = s.maintain("upload_backup_83b1a9", func() error {
		meta, dir, err := s.readUpload(r, r.PathValue("id"))
		if err != nil {
			return err
		}
		if meta.Validated {
			return i18n.New("w_a_validated_upload_cannot_ce0e63", errMaintenanceInput)
		}
		f, err := os.OpenFile(filepath.Join(dir, "archive.zip"), os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		if info.Size() != offset {
			return i18n.New("w_upload_offset_does_not_95e21e", errMaintenanceInput)
		}
		limit := min(maintenanceChunkBytes, meta.Size-offset)
		if limit <= 0 {
			return i18n.New("w_upload_size_exceeds_the_0bb329", errMaintenanceInput)
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				return i18n.New("w_w_f0fd7d", errMaintenanceInput, err)
			}
			return err
		}
		if len(data) == 0 {
			return i18n.New("w_upload_content_is_empty_7c0bb2", errMaintenanceInput)
		}
		if err = enoughSpace(dir, int64(len(data))); err != nil {
			return err
		}
		n, err := f.WriteAt(data, offset)
		if err != nil {
			return errors.Join(err, f.Truncate(offset))
		}
		if err = f.Sync(); err != nil {
			return errors.Join(err, f.Truncate(offset))
		}
		next = offset + int64(n)
		return nil
	})
	if err != nil {
		s.maintenanceError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]int64{"offset": next})
}
func backupResourceError(err error) error {
	var pathError *os.PathError
	// Missing files or file/directory type mismatches are archive errors; other disk failures remain server errors.
	if errors.As(err, &pathError) && !errors.Is(pathError, os.ErrNotExist) && !errors.Is(pathError, syscall.ENOTDIR) && !errors.Is(pathError, syscall.EISDIR) {
		return err
	}
	return i18n.New("w_w_f0fd7d", backup.ErrInvalidArchive, err)
}

func (s *Server) validateResources(stage string) error {
	temp := &Server{FontsDir: filepath.Join(stage, "app", "fonts"), ThemesDir: filepath.Join(stage, "app", "themes"), PluginsDir: filepath.Join(stage, "app", "plugins")}
	for _, kind := range []string{"fonts", "themes", "plugins"} {
		resourceDir := filepath.Join(stage, "app", kind)
		info, err := os.Stat(resourceDir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return backupResourceError(err)
		}
		if !info.IsDir() {
			return i18n.New("w_the_resource_directory_contains_3898a5", errMaintenanceInput)
		}
		entries, err := os.ReadDir(resourceDir)
		if err != nil {
			return backupResourceError(err)
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				return i18n.New("w_the_resource_directory_contains_3898a5", errMaintenanceInput)
			}
			switch kind {
			case "fonts":
				dir, _, err := temp.openFont(entry.Name())
				if err != nil {
					return backupResourceError(err)
				}
				dir.Close()
			case "themes":
				if _, _, err := temp.readTheme(entry.Name()); err != nil {
					return backupResourceError(err)
				}
			case "plugins":
				dir, _, err := temp.openPlugin(entry.Name())
				if err != nil {
					return backupResourceError(err)
				}
				dir.Close()
			}
		}
	}
	return nil
}
func (s *Server) validateMaintenanceUpload(w http.ResponseWriter, r *http.Request) {
	var manifest backup.Manifest
	var bytes int64
	err := s.maintain("validate_backup_09df97", func() error {
		meta, dir, err := s.readUpload(r, r.PathValue("id"))
		if err != nil {
			return err
		}
		info, err := os.Stat(filepath.Join(dir, "archive.zip"))
		if err != nil {
			return err
		}
		if info.Size() != meta.Size {
			return i18n.New("w_upload_is_not_complete_8ef575", errMaintenanceInput)
		}
		meta.Validated = false
		if err = saveUpload(dir, meta); err != nil {
			return err
		}
		stage := filepath.Join(dir, "stage")
		if err = os.RemoveAll(stage); err != nil {
			return err
		}
		if err = os.Mkdir(stage, 0700); err != nil {
			return err
		}
		manifest, err = backup.Extract(r.Context(), filepath.Join(dir, "archive.zip"), stage)
		if err != nil {
			return err
		}
		if manifest.Kind != meta.Kind {
			return i18n.New("w_backup_type_does_not_8e5e8c", errMaintenanceInput)
		}
		for _, entry := range manifest.Entries {
			bytes += entry.Size
			if strings.HasPrefix(entry.Path, "vault/") && backup.VaultExcluded(s.DataDir, s.vault.Root(), strings.TrimPrefix(entry.Path, "vault/")) {
				return i18n.New("w_vault_content_conflicts_with_6e3d24", errMaintenanceInput)
			}
		}
		if err = enoughSpace(dir, bytes*2); err != nil {
			return err
		}
		if err = s.validateResources(stage); err != nil {
			return err
		}
		if meta.Kind == "settings" {
			_, err = readPreferences(stage)
		} else {
			err = backup.CheckDatabase(filepath.Join(stage, "app", "rawmark.db"))
			if err == nil {
				var st *store.Store
				st, err = store.OpenExisting(filepath.Join(stage, "app", "rawmark.db"))
				if err == nil {
					var prefs map[string]json.RawMessage
					prefs, err = st.Preferences()
					if err == nil {
						err = validatePreferences(prefs)
					} else {
						var databaseError *sqlite.Error
						if !errors.As(err, &databaseError) {
							err = i18n.New("w_w_f0fd7d", backup.ErrInvalidArchive, err)
						}
					}
					err = errors.Join(err, st.Close())
				}
			}
		}
		if err != nil {
			return err
		}
		meta.Validated = true
		return saveUpload(dir, meta)
	})
	if err != nil {
		s.maintenanceError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"kind": manifest.Kind, "createdAt": manifest.CreatedAt, "entries": len(manifest.Entries), "size": bytes})
}
func (s *Server) deleteMaintenanceUpload(w http.ResponseWriter, r *http.Request) {
	err := s.maintain("cancel_upload_a24836", func() error {
		_, dir, err := s.readUpload(r, r.PathValue("id"))
		if err != nil {
			return err
		}
		return os.RemoveAll(dir)
	})
	if err != nil {
		s.maintenanceError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) restoreInstance(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID        string
		Confirmed bool
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !body.Confirmed {
		writeError(w, 400, message(w, "confirm_replacing_instance_data_and_52f3ca"))
		return
	}
	if s.Restart == nil {
		writeError(w, 503, message(w, "this_service_does_not_support_a9a8ba"))
		return
	}
	err := s.maintain("restore_full_instance_9b4ee0", func() error {
		meta, dir, err := s.readUpload(r, body.ID)
		if err != nil {
			return err
		}
		if !meta.Validated || meta.Kind != "full" {
			return i18n.New("w_validate_the_full_instance_6d329d", errMaintenanceInput)
		}
		file, err := s.saveRollback(r.Context(), "full")
		if err != nil {
			return err
		}
		if err = backup.WriteRecord(s.DataDir, backup.RestoreRecord{State: "prepared", Stage: filepath.Join(dir, "stage"), Backup: file}); err != nil {
			return err
		}
		s.restarting.Store(true)
		return nil
	})
	if err != nil {
		s.maintenanceError(w, r, err)
		return
	}
	writeJSON(w, 202, map[string]bool{"restarting": true})
	s.Restart()
}

type cleanupResult struct {
	Files  int      `json:"files"`
	Bytes  int64    `json:"bytes"`
	Failed []string `json:"failed"`
}

func (s *Server) clearTemp(w http.ResponseWriter, r *http.Request) {
	result := cleanupResult{Failed: []string{}}
	err := s.maintain("clean_temporary_files_af91ae", func() error {
		// temp belongs to this process; ordinary APIs and maintenance have drained. Restore archives and rollback backups live elsewhere.
		temp, err := s.tempDir()
		if err != nil {
			return err
		}
		entries, err := os.ReadDir(temp)
		if err != nil {
			return err
		}
		targets := []string{}
		for _, entry := range entries {
			targets = append(targets, filepath.Join(temp, entry.Name()))
		}
		// Clean only expired unused uploads; retain new uploads from the current session and pending restore contents.
		uploads := filepath.Join(s.DataDir, ".maintenance", "uploads")
		entries, err = os.ReadDir(uploads)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		for _, entry := range entries {
			if !uploadIDPattern.MatchString(entry.Name()) {
				continue
			}
			info, e := entry.Info()
			if e != nil {
				return e
			}
			if time.Since(info.ModTime()) > 24*time.Hour {
				targets = append(targets, filepath.Join(uploads, entry.Name()))
			}
		}
		err = filepath.WalkDir(s.vault.Root(), func(p string, d os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if strings.HasPrefix(d.Name(), ".rawmark-tmp-") {
				targets = append(targets, p)
				if d.IsDir() {
					return filepath.SkipDir
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		for _, target := range targets {
			var count int
			var size int64
			e := filepath.WalkDir(target, func(p string, d os.DirEntry, e error) error {
				if e != nil {
					return e
				}
				info, e := d.Info()
				if e != nil {
					return e
				}
				if info.Mode().IsRegular() {
					count++
					size += info.Size()
				}
				return nil
			})
			if e == nil {
				e = os.RemoveAll(target)
			}
			if e != nil {
				result.Failed = append(result.Failed, i18n.RenderError(e, responseLocale(w)))
			} else {
				result.Files += count
				result.Bytes += size
			}
		}
		return nil
	})
	if err != nil {
		s.maintenanceError(w, r, err)
		return
	}
	writeJSON(w, 200, result)
}

// Read restore results only before service startup; never disguise an empty response as a completed restore.
func (s *Server) SetRestoreFailure(err error) {
	s.maintenanceStatusMu.Lock()
	defer s.maintenanceStatusMu.Unlock()
	s.maintenanceState = maintenanceStatus{Operation: "restore_full_instance_9b4ee0", Error: err.Error(), cause: err, FinishedAt: time.Now().UnixMilli()}
}
