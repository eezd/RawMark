package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
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
		return meta, "", fmt.Errorf("%w：上传 ID 无效", errMaintenanceInput)
	}
	dir := filepath.Join(s.DataDir, ".maintenance", "uploads", id)
	data, err := os.ReadFile(filepath.Join(dir, "upload.json"))
	if errors.Is(err, os.ErrNotExist) {
		return meta, "", fmt.Errorf("%w：上传不存在或已过期", errMaintenanceInput)
	}
	if err != nil {
		return meta, "", err
	}
	if err = json.Unmarshal(data, &meta); err != nil {
		return meta, "", err
	}
	if meta.Owner != uploadOwner(r) {
		return meta, "", fmt.Errorf("%w：上传不属于当前会话", errMaintenanceInput)
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
	var stat syscall.Statfs_t
	if err := syscall.Statfs(dir, &stat); err != nil {
		return err
	}
	if size < 0 || uint64(size)+(32<<20) > stat.Bavail*uint64(stat.Bsize) {
		return fmt.Errorf("磁盘空间不足：%w", syscall.ENOSPC)
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
		writeError(w, 400, "请选择有效备份，压缩大小上限 2 GiB")
		return
	}
	var id string
	err := s.maintain("准备上传", func() error {
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
		writeError(w, 400, "上传偏移无效")
		return
	}
	var next int64
	err = s.maintain("上传备份", func() error {
		meta, dir, err := s.readUpload(r, r.PathValue("id"))
		if err != nil {
			return err
		}
		if meta.Validated {
			return fmt.Errorf("%w：已校验的上传不可修改", errMaintenanceInput)
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
			return fmt.Errorf("%w：上传偏移不匹配，请重新上传", errMaintenanceInput)
		}
		limit := min(maintenanceChunkBytes, meta.Size-offset)
		if limit <= 0 {
			return fmt.Errorf("%w：上传大小超出清单", errMaintenanceInput)
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				return fmt.Errorf("%w：%w", errMaintenanceInput, err)
			}
			return err
		}
		if len(data) == 0 {
			return fmt.Errorf("%w：上传内容为空", errMaintenanceInput)
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
	// 缺失文件或文件／目录类型错误来自归档内容；其他磁盘故障仍由服务端处理。
	if errors.As(err, &pathError) && !errors.Is(pathError, os.ErrNotExist) && !errors.Is(pathError, syscall.ENOTDIR) && !errors.Is(pathError, syscall.EISDIR) {
		return err
	}
	return fmt.Errorf("%w：%w", backup.ErrInvalidArchive, err)
}

func (s *Server) validateResources(stage string) error {
	temp := &Server{FontsDir: filepath.Join(stage, "app", "fonts"), ThemesDir: filepath.Join(stage, "app", "themes"), PluginsDir: filepath.Join(stage, "app", "plugins")}
	for _, kind := range []string{"fonts", "themes", "plugins"} {
		entries, err := os.ReadDir(filepath.Join(stage, "app", kind))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return backupResourceError(err)
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				return fmt.Errorf("%w：资源目录内包含非目录条目", errMaintenanceInput)
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
	err := s.maintain("校验备份", func() error {
		meta, dir, err := s.readUpload(r, r.PathValue("id"))
		if err != nil {
			return err
		}
		info, err := os.Stat(filepath.Join(dir, "archive.zip"))
		if err != nil {
			return err
		}
		if info.Size() != meta.Size {
			return fmt.Errorf("%w：上传尚未完成", errMaintenanceInput)
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
			return fmt.Errorf("%w：备份类型与所选操作不符", errMaintenanceInput)
		}
		for _, entry := range manifest.Entries {
			bytes += entry.Size
			if strings.HasPrefix(entry.Path, "vault/") && backup.VaultExcluded(s.DataDir, s.vault.Root(), strings.TrimPrefix(entry.Path, "vault/")) {
				return fmt.Errorf("%w：笔记库内容与应用目录冲突", errMaintenanceInput)
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
							err = fmt.Errorf("%w：%w", backup.ErrInvalidArchive, err)
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
	err := s.maintain("取消上传", func() error {
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
		writeError(w, 400, "请先确认替换实例数据并重新登录")
		return
	}
	if s.Restart == nil {
		writeError(w, 503, "当前服务不支持实例恢复")
		return
	}
	err := s.maintain("恢复完整实例", func() error {
		meta, dir, err := s.readUpload(r, body.ID)
		if err != nil {
			return err
		}
		if !meta.Validated || meta.Kind != "full" {
			return fmt.Errorf("%w：请先校验完整服务备份", errMaintenanceInput)
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
	err := s.maintain("清理临时文件", func() error {
		// temp 为进程专属目录，普通 API 与维护已排空；恢复包和回退备份在其他目录。
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
		// 只清理过期未使用上传；当前会话新上传和待恢复内容不会被清除。
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
				result.Failed = append(result.Failed, e.Error())
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

// 仅用于服务启动前读取恢复结果，不以空响应伪装已恢复。
func (s *Server) SetRestoreFailure(err error) {
	s.maintenanceStatusMu.Lock()
	defer s.maintenanceStatusMu.Unlock()
	s.maintenanceState = maintenanceStatus{Operation: "恢复完整实例", Error: err.Error(), FinishedAt: time.Now().UnixMilli()}
}
