package api

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"rawmark/internal/fileutil"
	"rawmark/internal/i18n"
	"regexp"
	"strings"

	"rawmark/internal/events"
)

const maxPluginZip = 10 << 20
const maxPluginExpanded = 20 << 20
const pluginEnabledKey = "plugins.enabled"

var pluginIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var pluginRevisionPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type pluginManifest struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Version    string `json:"version"`
	APIVersion int    `json:"apiVersion"`
}

type pluginInfo struct {
	pluginManifest
	Revision string `json:"revision"`
	Enabled  bool   `json:"enabled"`
}

func validPluginID(id string) bool {
	return pluginIDPattern.MatchString(id) && fileutil.IsLocalPath(id) && !strings.HasPrefix(id, "rawmark-")
}

func parsePluginManifest(data []byte) (pluginManifest, error) {
	var m pluginManifest
	if len(data) > 16<<10 || json.Unmarshal(data, &m) != nil || !validPluginID(m.ID) || strings.TrimSpace(m.Name) == "" || strings.TrimSpace(m.Version) == "" || m.APIVersion != 1 {
		return m, i18n.New("invalid_plugin_manifest_a_valid_121d94")
	}
	return m, nil
}

func (s *Server) openPlugin(id string) (*os.Root, pluginInfo, error) {
	var info pluginInfo
	if !validPluginID(id) || s.PluginsDir == "" {
		return nil, info, fs.ErrNotExist
	}
	root, err := os.OpenRoot(s.PluginsDir)
	if err != nil {
		return nil, info, err
	}
	defer root.Close()
	dir, err := root.OpenRoot(id)
	if err != nil {
		return nil, info, err
	}
	ok := false
	defer func() {
		if !ok {
			dir.Close()
		}
	}()
	data, err := dir.ReadFile("manifest.json")
	if err != nil {
		return nil, info, err
	}
	m, err := parsePluginManifest(data)
	if err != nil {
		return nil, info, err
	}
	if m.ID != id {
		return nil, info, i18n.New("plugin_directory_does_not_match_0eda90")
	}
	rev, err := dir.ReadFile(".rawmark-revision")
	if err != nil {
		return nil, info, err
	}
	if !pluginRevisionPattern.Match(rev) {
		return nil, info, i18n.New("invalid_plugin_installation_information_3e7873")
	}
	info.pluginManifest, info.Revision = m, string(rev)
	ok = true
	return dir, info, nil
}

func (s *Server) enabledPlugins() (map[string]bool, error) {
	value, ok, err := s.store.Setting(pluginEnabledKey)
	if err != nil {
		return nil, err
	}
	enabled := map[string]bool{}
	if ok {
		err = json.Unmarshal([]byte(value), &enabled)
	}
	if enabled == nil && err == nil {
		err = i18n.New("invalid_plugin_enabled_configuration_26d4bb")
	}
	return enabled, err
}

func (s *Server) setPluginEnabled(id string, enabled bool) error {
	values, err := s.enabledPlugins()
	if err != nil {
		return err
	}
	if enabled {
		values[id] = true
	} else {
		delete(values, id)
	}
	data, err := json.Marshal(values)
	if err != nil {
		return err
	}
	return s.store.SetSetting(pluginEnabledKey, string(data))
}

func (s *Server) pluginError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, fs.ErrNotExist) {
		writeError(w, 404, message(w, "plugin_not_found_or_installation_f577c6"))
	} else {
		internalError(w, r, err)
	}
}

func (s *Server) listPlugins(w http.ResponseWriter, r *http.Request) {
	s.pluginsMu.Lock()
	defer s.pluginsMu.Unlock()
	installed := []pluginInfo{}
	enabled, err := s.enabledPlugins()
	if err != nil {
		internalError(w, r, err)
		return
	}
	if s.PluginsDir != "" {
		entries, err := os.ReadDir(s.PluginsDir)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			internalError(w, r, err)
			return
		}
		for _, entry := range entries {
			if !entry.IsDir() || !validPluginID(entry.Name()) {
				continue
			}
			dir, info, err := s.openPlugin(entry.Name())
			if err != nil {
				s.pluginError(w, r, err)
				return
			}
			dir.Close()
			info.Enabled = enabled[info.ID]
			installed = append(installed, info)
		}
	}
	writeJSON(w, 200, map[string]any{"plugins": installed})
}

func unpackPlugin(data []byte, destination string) (pluginInfo, error) {
	var info pluginInfo
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return info, i18n.New("could_not_read_plugin_zip_922fd9")
	}
	if len(archive.File) > 128 {
		return info, i18n.New("a_plugin_may_contain_at_41c105")
	}
	seen := map[string]bool{}
	var total int64
	for _, file := range archive.File {
		name := strings.TrimSuffix(file.Name, "/")
		if !fs.ValidPath(name) || !fileutil.IsLocalPath(name) || strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, ".") || name != path.Clean(name) || seen[name] || (!file.FileInfo().IsDir() && !file.Mode().IsRegular()) {
			return info, i18n.New("plugin_contains_invalid_paths_duplicate_6a1e05")
		}
		seen[name] = true
		if file.FileInfo().IsDir() {
			continue
		}
		if file.UncompressedSize64 > maxPluginExpanded || total+int64(file.UncompressedSize64) > maxPluginExpanded {
			return info, i18n.New("expanded_plugin_exceeds_mib_e06d7b")
		}
		src, err := file.Open()
		if err != nil {
			return info, i18n.New("could_not_read_plugin_file_016a17", err)
		}
		content, readErr := io.ReadAll(io.LimitReader(src, maxPluginExpanded-total+1))
		closeErr := src.Close()
		if readErr != nil {
			return info, readErr
		}
		if closeErr != nil {
			return info, closeErr
		}
		total += int64(len(content))
		if total > maxPluginExpanded {
			return info, i18n.New("expanded_plugin_exceeds_mib_e06d7b")
		}
		if name == "manifest.json" {
			info.pluginManifest, err = parsePluginManifest(content)
			if err != nil {
				return info, err
			}
		}
		full := filepath.Join(destination, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			return info, err
		}
		if err := os.WriteFile(full, content, 0o600); err != nil {
			return info, err
		}
	}
	if info.ID == "" || !seen["main.js"] {
		return info, i18n.New("the_zip_root_must_contain_ee8588")
	}
	main, err := os.Stat(filepath.Join(destination, "main.js"))
	if err != nil || !main.Mode().IsRegular() {
		return info, i18n.New("main_js_must_be_a_e84ee8")
	}
	hash := sha256.Sum256(data)
	info.Revision = hex.EncodeToString(hash[:])
	err = os.WriteFile(filepath.Join(destination, ".rawmark-revision"), []byte(info.Revision), 0o600)
	return info, err
}

func (s *Server) installPlugin(w http.ResponseWriter, r *http.Request) {
	if s.PluginsDir == "" {
		writeError(w, 503, message(w, "plugin_directory_is_not_configured_5e0928"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPluginZip+(64<<10))
	if err := r.ParseMultipartForm(maxPluginZip); err != nil {
		writeError(w, 400, message(w, "could_not_read_plugin_upload_5fd8bc"))
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, message(w, "choose_a_plugin_zip_file_7360c5"))
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxPluginZip+1))
	if err != nil {
		internalError(w, r, err)
		return
	}
	if len(data) > maxPluginZip {
		writeError(w, 413, message(w, "plugin_zip_exceeds_mib_046e37"))
		return
	}
	s.pluginsMu.Lock()
	defer s.pluginsMu.Unlock()
	if err := os.MkdirAll(s.PluginsDir, 0o700); err != nil {
		internalError(w, r, err)
		return
	}
	stage, err := os.MkdirTemp(s.PluginsDir, ".install-")
	if err != nil {
		internalError(w, r, err)
		return
	}
	defer os.RemoveAll(stage)
	info, err := unpackPlugin(data, stage)
	if err != nil {
		writeError(w, 400, i18n.RenderError(err, responseLocale(w)))
		return
	}
	target := filepath.Join(s.PluginsDir, info.ID)
	if _, err := os.Lstat(target); err == nil {
		writeError(w, 409, message(w, "a_plugin_with_this_id_1551cb"))
		return
	} else if !errors.Is(err, fs.ErrNotExist) {
		internalError(w, r, err)
		return
	}
	if err := s.setPluginEnabled(info.ID, false); err != nil {
		internalError(w, r, err)
		return
	}
	if err := os.Rename(stage, target); err != nil {
		internalError(w, r, err)
		return
	}
	s.hub.Broadcast(events.Event{Type: "plugins"})
	writeJSON(w, 201, info)
}

func (s *Server) togglePlugin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Enabled == nil {
		writeError(w, 400, message(w, "enabled_must_be_specified_12873c"))
		return
	}
	s.pluginsMu.Lock()
	defer s.pluginsMu.Unlock()
	dir, info, err := s.openPlugin(r.PathValue("id"))
	if err != nil {
		s.pluginError(w, r, err)
		return
	}
	dir.Close()
	if err := s.setPluginEnabled(info.ID, *body.Enabled); err != nil {
		internalError(w, r, err)
		return
	}
	info.Enabled = *body.Enabled
	s.hub.Broadcast(events.Event{Type: "settings"})
	writeJSON(w, 200, info)
}

func (s *Server) uninstallPlugin(w http.ResponseWriter, r *http.Request) {
	s.pluginsMu.Lock()
	defer s.pluginsMu.Unlock()
	id := r.PathValue("id")
	dir, _, err := s.openPlugin(id)
	if err != nil {
		s.pluginError(w, r, err)
		return
	}
	dir.Close()
	if err := s.setPluginEnabled(id, false); err != nil {
		internalError(w, r, err)
		return
	}
	if err := os.RemoveAll(filepath.Join(s.PluginsDir, id)); err != nil {
		internalError(w, r, err)
		return
	}
	s.hub.Broadcast(events.Event{Type: "plugins"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) pluginAsset(w http.ResponseWriter, r *http.Request) {
	s.pluginsMu.Lock()
	defer s.pluginsMu.Unlock()
	dir, info, err := s.openPlugin(r.PathValue("id"))
	if err != nil {
		s.pluginError(w, r, err)
		return
	}
	defer dir.Close()
	name := r.PathValue("path")
	if r.PathValue("revision") != info.Revision || !fs.ValidPath(name) || strings.ContainsAny(name, "\\:") || strings.HasPrefix(name, ".") {
		writeError(w, 404, message(w, "plugin_resource_not_found_8e73f3"))
		return
	}
	file, err := dir.Open(name)
	if err != nil {
		s.pluginError(w, r, err)
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !stat.Mode().IsRegular() {
		writeError(w, 404, message(w, "plugin_resource_not_found_8e73f3"))
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	ext := path.Ext(name)
	if ext == ".js" || ext == ".mjs" {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	} else {
		ct := mime.TypeByExtension(ext)
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	}
	http.ServeContent(w, r, name, stat.ModTime(), file)
}

func (s *Server) getPluginData(w http.ResponseWriter, r *http.Request) {
	s.pluginsMu.Lock()
	defer s.pluginsMu.Unlock()
	id := r.PathValue("id")
	dir, _, err := s.openPlugin(id)
	if err != nil {
		s.pluginError(w, r, err)
		return
	}
	dir.Close()
	value, ok, err := s.store.Setting("plugin.data." + id)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !ok {
		value = "null"
	}
	writeJSON(w, 200, map[string]any{"data": json.RawMessage(value)})
}

func (s *Server) putPluginData(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Data json.RawMessage `json:"data"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.Data) == 0 {
		writeError(w, 400, message(w, "data_must_be_provided_0dc1bc"))
		return
	}
	s.pluginsMu.Lock()
	defer s.pluginsMu.Unlock()
	id := r.PathValue("id")
	dir, _, err := s.openPlugin(id)
	if err != nil {
		s.pluginError(w, r, err)
		return
	}
	dir.Close()
	if err := s.store.SetSetting("plugin.data."+id, string(body.Data)); err != nil {
		internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"data": body.Data})
}
