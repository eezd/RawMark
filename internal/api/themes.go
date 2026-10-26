package api

import (
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"rawmark/internal/i18n"
	"regexp"
)

var themeIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

type themeManifest struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version"`
}

//go:embed themes/white.css
var whiteThemeCSS string

//go:embed themes/black.css
var blackThemeCSS string

var builtinThemes = []struct {
	themeManifest
	css string
}{
	{themeManifest{"white", "白色", "1"}, whiteThemeCSS},
	{themeManifest{"black", "黑色", "1"}, blackThemeCSS},
}

func builtinTheme(id string) (themeManifest, string, bool) {
	for _, theme := range builtinThemes {
		if theme.ID == id {
			return theme.themeManifest, theme.css, true
		}
	}
	return themeManifest{}, "", false
}

func readThemeFile(root *os.Root, name string, limit int64) ([]byte, error) {
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, i18n.New("theme_file_must_be_a_1fe9df")
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, i18n.New("theme_file_is_too_large_08667a")
	}
	return data, nil
}

func (s *Server) readTheme(id string) (themeManifest, string, error) {
	if manifest, css, ok := builtinTheme(id); ok {
		return manifest, css, nil
	}
	var manifest themeManifest
	if !themeIDPattern.MatchString(id) || id == "default" || s.ThemesDir == "" {
		return manifest, "", fs.ErrNotExist
	}
	root, err := os.OpenRoot(s.ThemesDir)
	if err != nil {
		return manifest, "", err
	}
	defer root.Close()
	dir, err := root.OpenRoot(id)
	if err != nil {
		return manifest, "", err
	}
	defer dir.Close()
	data, err := readThemeFile(dir, "manifest.json", 16<<10)
	if err != nil {
		return manifest, "", err
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return manifest, "", i18n.New("could_not_parse_manifest_json_4bef07", id, err)
	}
	if manifest.ID != id || manifest.Name == "" || manifest.Version == "" {
		return manifest, "", i18n.New("theme_s_has_an_invalid_8ed29c", id)
	}
	css, err := readThemeFile(dir, "theme.css", 256<<10)
	return manifest, string(css), err
}

func (s *Server) listThemes(w http.ResponseWriter, r *http.Request) {
	themes := []themeManifest{{ID: "default", Name: message(w, "theme_default"), Version: "1"}}
	for _, theme := range builtinThemes {
		manifest := theme.themeManifest
		manifest.Name = message(w, "theme_"+theme.ID)
		themes = append(themes, manifest)
	}
	if s.ThemesDir != "" {
		entries, err := os.ReadDir(s.ThemesDir)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			internalError(w, r, err)
			return
		}
		for _, entry := range entries {
			if _, _, ok := builtinTheme(entry.Name()); ok {
				continue
			}
			if !entry.IsDir() || !themeIDPattern.MatchString(entry.Name()) || entry.Name() == "default" {
				continue
			}
			manifest, _, err := s.readTheme(entry.Name())
			if err != nil {
				internalError(w, r, err)
				return
			}
			themes = append(themes, manifest)
		}
	}
	writeJSON(w, 200, map[string]any{"themes": themes})
}

func (s *Server) getTheme(w http.ResponseWriter, r *http.Request) {
	manifest, css, err := s.readTheme(r.PathValue("id"))
	if errors.Is(err, fs.ErrNotExist) {
		writeError(w, 404, message(w, "theme_not_found_or_files_3b0d5b"))
		return
	}
	if err != nil {
		internalError(w, r, err)
		return
	}
	if _, _, ok := builtinTheme(manifest.ID); ok {
		manifest.Name = message(w, "theme_"+manifest.ID)
	}
	writeJSON(w, 200, struct {
		themeManifest
		CSS string `json:"css"`
	}{manifest, css})
}
