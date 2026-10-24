package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"rawmark/internal/events"
)

const maxFontBytes = 30 << 20

var fontIDPattern = regexp.MustCompile(`^custom-[a-f0-9]{64}$`)

type fontInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Format string `json:"format"`
}

func (s *Server) openFont(id string) (*os.Root, fontInfo, error) {
	var info fontInfo
	if !fontIDPattern.MatchString(id) || s.FontsDir == "" {
		return nil, info, fs.ErrNotExist
	}
	root, err := os.OpenRoot(s.FontsDir)
	if err != nil {
		return nil, info, err
	}
	defer root.Close()
	dir, err := root.OpenRoot(id)
	if err != nil {
		return nil, info, err
	}
	data, err := dir.ReadFile("manifest.json")
	if err == nil {
		err = json.Unmarshal(data, &info)
	}
	if err == nil && (info.ID != id || info.Name == "" || !validFontFormat(info.Format)) {
		err = fmt.Errorf("字体安装信息无效")
	}
	if err != nil {
		dir.Close()
		return nil, info, err
	}
	return dir, info, nil
}

func validFontFormat(format string) bool {
	return format == "ttf" || format == "otf" || format == "woff" || format == "woff2"
}

func (s *Server) listFonts(w http.ResponseWriter, r *http.Request) {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	fonts := []fontInfo{}
	if s.FontsDir != "" {
		entries, err := os.ReadDir(s.FontsDir)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			internalError(w, r, err)
			return
		}
		for _, entry := range entries {
			if !entry.IsDir() || !fontIDPattern.MatchString(entry.Name()) {
				continue
			}
			dir, info, err := s.openFont(entry.Name())
			if err != nil {
				internalError(w, r, err)
				return
			}
			dir.Close()
			fonts = append(fonts, info)
		}
	}
	writeJSON(w, 200, map[string]any{"fonts": fonts})
}

func (s *Server) importFont(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFontBytes+(1<<20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		writeError(w, 400, "无法读取字体文件，单个文件上限 30 MB")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, "请选择字体文件")
		return
	}
	defer f.Close()
	format := strings.TrimPrefix(strings.ToLower(filepath.Ext(header.Filename)), ".")
	data, err := io.ReadAll(io.LimitReader(f, maxFontBytes+1))
	if err != nil {
		internalError(w, r, err)
		return
	}
	if len(data) > maxFontBytes {
		writeError(w, 413, "字体文件超过 30 MB")
		return
	}
	magic := map[string]string{"ttf": "\x00\x01\x00\x00", "otf": "OTTO", "woff": "wOFF", "woff2": "wOF2"}
	if !validFontFormat(format) || len(data) < 12 || string(data[:4]) != magic[format] {
		writeError(w, 400, "请导入有效的 TTF、OTF、WOFF 或 WOFF2 字体文件")
		return
	}
	if s.FontsDir == "" {
		writeError(w, 503, "字体目录未配置")
		return
	}
	hash := sha256.Sum256(data)
	id := "custom-" + hex.EncodeToString(hash[:])
	info := fontInfo{id, strings.TrimSuffix(filepath.Base(header.Filename), filepath.Ext(header.Filename)), format}
	if strings.TrimSpace(info.Name) == "" || len(info.Name) > 200 || strings.ContainsAny(info.Name, "\x00\r\n") {
		writeError(w, 400, "字体文件名无效或过长")
		return
	}
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	if dir, existing, err := s.openFont(id); err == nil {
		dir.Close()
		writeJSON(w, 200, existing)
		return
	} else if !errors.Is(err, fs.ErrNotExist) {
		internalError(w, r, err)
		return
	}
	if err := os.MkdirAll(s.FontsDir, 0o755); err != nil {
		internalError(w, r, err)
		return
	}
	stage, err := os.MkdirTemp(s.FontsDir, ".import-")
	if err != nil {
		internalError(w, r, err)
		return
	}
	defer os.RemoveAll(stage)
	manifest, err := json.Marshal(info)
	if err == nil {
		err = os.WriteFile(filepath.Join(stage, "manifest.json"), manifest, 0o600)
	}
	if err == nil {
		err = os.WriteFile(filepath.Join(stage, "font."+format), data, 0o600)
	}
	if err == nil {
		err = os.Rename(stage, filepath.Join(s.FontsDir, id))
	}
	if err != nil {
		internalError(w, r, err)
		return
	}
	s.hub.Broadcast(events.Event{Type: "settings"})
	writeJSON(w, 201, info)
}

func (s *Server) fontFile(w http.ResponseWriter, r *http.Request) {
	s.settingsMu.Lock()
	dir, info, err := s.openFont(r.PathValue("id"))
	if errors.Is(err, fs.ErrNotExist) {
		s.settingsMu.Unlock()
		writeError(w, 404, "字体不存在")
		return
	}
	if err != nil {
		s.settingsMu.Unlock()
		internalError(w, r, err)
		return
	}
	defer dir.Close()
	f, err := dir.Open("font." + info.Format)
	s.settingsMu.Unlock()
	if err != nil {
		internalError(w, r, err)
		return
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		if err == nil {
			err = fmt.Errorf("字体必须为普通文件")
		}
		internalError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "font/"+info.Format)
	http.ServeContent(w, r, "font."+info.Format, stat.ModTime(), f)
}

func (s *Server) deleteFont(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "maple" {
		writeError(w, 400, "Maple 是默认字体，不可删除")
		return
	}
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	dir, _, err := s.openFont(id)
	if errors.Is(err, fs.ErrNotExist) {
		writeError(w, 404, "字体不存在")
		return
	}
	if err != nil {
		internalError(w, r, err)
		return
	}
	dir.Close()
	settings, err := s.readSettings()
	if err != nil {
		internalError(w, r, err)
		return
	}
	for _, key := range []string{"uiFont", "textFont", "codeFont"} {
		var selected string
		if json.Unmarshal(settings[key], &selected) == nil && selected == id {
			settings[key] = json.RawMessage(`"maple"`)
		}
	}
	data, err := json.Marshal(settings)
	if err != nil {
		internalError(w, r, err)
		return
	}
	root, err := os.OpenRoot(s.FontsDir)
	if err != nil {
		internalError(w, r, err)
		return
	}
	defer root.Close()
	// 先撤下资源；设置写失败时恢复，避免留下指向已删除字体的设置。
	removed := ".remove-" + id
	if err := root.Rename(id, removed); err != nil {
		internalError(w, r, err)
		return
	}
	if err := s.store.SetSetting(settingsKey, string(data)); err != nil {
		internalError(w, r, errors.Join(err, root.Rename(removed, id)))
		return
	}
	s.hub.Broadcast(events.Event{Type: "settings"})
	if err := root.RemoveAll(removed); err != nil {
		internalError(w, r, fmt.Errorf("字体已停用，但文件清理失败：%w", err))
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
