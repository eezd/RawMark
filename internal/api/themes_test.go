package api

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestThemeAndShareAppearanceBoundaries(t *testing.T) {
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
	f.write("笔记.md", "正文")
	f.do(f.admin, "PATCH", "/api/v1/settings", `{"theme":"paper","colorMode":"dark","fontSize":18,"privateSetting":"不公开","cssSnippets":[{"id":"a","name":"启用","css":"body { color: red }","enabled":true},{"id":"b","name":"停用","css":"不公开片段","enabled":false}]}`, nil)
	sh := decode[shareView](t, f.do(f.admin, "POST", "/api/v1/shares", `{"path":"笔记.md","password":"访问密码"}`, nil))
	base := "/api/v1/public/shares/" + sh.Token
	if code := f.status(guest, "GET", base+"/appearance", "", nil); code != 401 {
		t.Fatalf("未解锁不能读取外观，得到 %d", code)
	}
	f.do(guest, "POST", base+"/unlock", `{"password":"访问密码"}`, nil)
	res := f.do(guest, "GET", base+"/appearance", "", nil)
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	var appearance map[string]any
	if err := json.Unmarshal(raw, &appearance); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 || appearance["colorMode"] != "dark" || !strings.Contains(appearance["themeCSS"].(string), "#faf6ed") {
		t.Fatalf("分享外观错误：%s", raw)
	}
	if strings.Contains(string(raw), "不公开") || len(appearance["cssSnippets"].([]any)) != 1 {
		t.Fatalf("分享泄露了其他设置或停用片段：%s", raw)
	}
	f.do(f.admin, "DELETE", "/api/v1/shares/"+sh.Token, "", nil)
	if code := f.status(guest, "GET", base+"/appearance", "", nil); code != 404 {
		t.Fatalf("撤销分享后不能读取外观，得到 %d", code)
	}
	// CSS 符号链接不能读取主题目录之外的应用数据。
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
