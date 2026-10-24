package api

import (
	"bytes"
	"database/sql"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func uploadTestFont(t *testing.T, f *fixture, client *http.Client, name string, data []byte) *http.Response {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest("POST", f.url+"/api/v1/fonts", &body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func testFontData(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("../../web/src/themes/fonts/maple/regular-00.woff2")
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestFontImportReuseReadAndDelete(t *testing.T) {
	f := newFixture(t)
	data := testFontData(t)
	info := decode[fontInfo](t, uploadTestFont(t, f, f.admin, "示例字体.woff2", data))
	if !fontIDPattern.MatchString(info.ID) || info.Name != "示例字体" || info.Format != "woff2" {
		t.Fatalf("字体信息错误：%+v", info)
	}
	again := decode[fontInfo](t, uploadTestFont(t, f, f.admin, "renamed.woff2", data))
	if again != info {
		t.Fatalf("相同内容未复用原字体：%+v", again)
	}
	list := decode[struct{ Fonts []fontInfo }](t, f.do(f.admin, "GET", "/api/v1/fonts", "", nil))
	if len(list.Fonts) != 1 || list.Fonts[0] != info {
		t.Fatalf("列表不符：%+v", list)
	}
	res := f.do(f.admin, "GET", "/api/v1/fonts/"+info.ID+"/file", "", nil)
	got, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || !bytes.Equal(got, data) || res.Header.Get("Content-Type") != "font/woff2" {
		t.Fatal("字体文件不一致", err)
	}
	f.do(f.admin, "PATCH", "/api/v1/settings", `{"uiFont":"`+info.ID+`","textFont":"`+info.ID+`","codeFont":"`+info.ID+`","plugin.data":{"keep":true}}`, nil).Body.Close()
	f.do(f.admin, "DELETE", "/api/v1/fonts/"+info.ID, "", nil).Body.Close()
	settings := decode[map[string]any](t, f.do(f.admin, "GET", "/api/v1/settings", "", nil))
	for _, key := range []string{"uiFont", "textFont", "codeFont"} {
		if settings[key] != "maple" {
			t.Fatalf("%s 未恢复默认：%v", key, settings[key])
		}
	}
	if settings["plugin.data"] == nil {
		t.Fatal("无关设置被删除")
	}
	if code := f.status(f.admin, "GET", "/api/v1/fonts/"+info.ID+"/file", "", nil); code != 404 {
		t.Fatal("已删除字体仍可读取", code)
	}
	list = decode[struct{ Fonts []fontInfo }](t, f.do(f.admin, "GET", "/api/v1/fonts", "", nil))
	if len(list.Fonts) != 0 {
		t.Fatal("已删除字体仍在列表")
	}
}

func TestFontBoundaries(t *testing.T) {
	f := newFixture(t)
	guest := newClient()
	for _, endpoint := range []string{"/api/v1/fonts", "/api/v1/fonts/maple/file"} {
		if code := f.status(guest, "GET", endpoint, "", nil); code != 401 {
			t.Fatal("匿名字体访问未拒绝", code)
		}
	}
	res := uploadTestFont(t, f, guest, "font.woff2", testFontData(t))
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal("匿名上传未拒绝", res.StatusCode)
	}
	if code := f.status(f.admin, "DELETE", "/api/v1/fonts/maple", "", nil); code != 400 {
		t.Fatal("Maple不应可删除", code)
	}
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"font.exe", testFontData(t)}, {"font.ttf", testFontData(t)}, {".woff2", testFontData(t)}, {"font.woff2", []byte("invalid")},
	} {
		res := uploadTestFont(t, f, f.admin, tc.name, tc.data)
		res.Body.Close()
		if res.StatusCode != 400 {
			t.Fatalf("非法字体 %s 未拒绝：%d", tc.name, res.StatusCode)
		}
	}
	res = uploadTestFont(t, f, f.admin, "large.woff2", bytes.Repeat([]byte{'x'}, maxFontBytes+1))
	res.Body.Close()
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatal("超大字体未拒绝", res.StatusCode)
	}
	token := decode[struct{ Token string }](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"fonts","scope":"write"}`, nil))
	for _, tc := range []struct{ method, path string }{{"GET", "/api/v1/fonts"}, {"DELETE", "/api/v1/fonts/maple"}} {
		if code := f.status(guest, tc.method, tc.path, "", map[string]string{"Authorization": "Bearer " + token.Token}); code != 403 {
			t.Fatal("令牌不应管理字体", code)
		}
	}
	info := decode[fontInfo](t, uploadTestFont(t, f, f.admin, "font.woff2", testFontData(t)))
	dir := filepath.Join(filepath.Dir(f.root), "fonts", info.ID)
	if err := os.Remove(filepath.Join(dir, "font.woff2")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(filepath.Dir(f.root), "rawmark.db"), filepath.Join(dir, "font.woff2")); err != nil {
		t.Fatal(err)
	}
	if code := f.status(f.admin, "GET", "/api/v1/fonts/"+info.ID+"/file", "", nil); code != 500 {
		t.Fatal("字体不应读取目录外的数据", code)
	}
}

func TestFontDeleteRollsBackWhenSettingsWriteFails(t *testing.T) {
	f := newFixture(t)
	info := decode[fontInfo](t, uploadTestFont(t, f, f.admin, "font.woff2", testFontData(t)))
	f.do(f.admin, "PATCH", "/api/v1/settings", `{"uiFont":"`+info.ID+`"}`, nil).Body.Close()
	db, err := sql.Open("sqlite", filepath.Join(filepath.Dir(f.root), "rawmark.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TRIGGER reject_font_settings BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'test write failure'); END`); err != nil {
		t.Fatal(err)
	}
	if code := f.status(f.admin, "DELETE", "/api/v1/fonts/"+info.ID, "", nil); code != 500 {
		t.Fatal("设置失败应报告错误", code)
	}
	res := f.do(f.admin, "GET", "/api/v1/fonts/"+info.ID+"/file", "", nil)
	res.Body.Close()
	settings := decode[map[string]any](t, f.do(f.admin, "GET", "/api/v1/settings", "", nil))
	if settings["uiFont"] != info.ID {
		t.Fatal("失败后设置未保留")
	}
	entries, err := os.ReadDir(filepath.Join(filepath.Dir(f.root), "fonts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".remove-") {
			t.Fatal("失败后字体未恢复")
		}
	}
}
