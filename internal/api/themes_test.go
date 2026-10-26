package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestThemeBoundaries(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(filepath.Dir(f.root), "themes", "paper")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{
		"manifest.json": `{"id":"paper","name":"纸张","version":"1"}`,
		"theme.css":     `:root { --rm-bg: #faf6ed; }`,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	guest := newClient()
	if code := f.status(guest, "GET", "/api/v1/themes/paper", "", nil); code != 401 {
		t.Fatalf("匿名用户不应读取主题，得到 %d", code)
	}
	themes := decode[struct{ Themes []themeManifest }](t, f.do(f.admin, "GET", "/api/v1/themes", "", nil))
	if len(themes.Themes) != 4 || themes.Themes[0].ID != "default" || themes.Themes[1].ID != "white" || themes.Themes[2].ID != "black" || themes.Themes[3].ID != "paper" {
		t.Fatalf("主题列表错误：%+v", themes.Themes)
	}
	for _, id := range []string{"white", "black"} {
		theme := decode[map[string]string](t, f.do(f.admin, "GET", "/api/v1/themes/"+id, "", nil))
		if theme["id"] != id || !strings.Contains(theme["css"], "--rm-bg:") {
			t.Fatalf("内置主题未提供配色：%s", id)
		}
	}
	theme := decode[map[string]string](t, f.do(f.admin, "GET", "/api/v1/themes/paper", "", nil))
	if !strings.Contains(theme["css"], "#faf6ed") {
		t.Fatal("未读取到主题 CSS")
	}
	// CSS symlinks must not expose application data outside the theme directory.
	if err := os.Remove(filepath.Join(dir, "theme.css")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(filepath.Dir(f.root), "rawmark.db"), filepath.Join(dir, "theme.css")); err != nil {
		t.Fatal(err)
	}
	if code := f.status(f.admin, "GET", "/api/v1/themes/paper", "", nil); code != http.StatusInternalServerError {
		t.Fatalf("应拒绝越界链接，得到 %d", code)
	}
}
