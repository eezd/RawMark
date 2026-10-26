package api

import (
	"archive/zip"
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"testing"
)

func pluginUpload(t *testing.T, f *fixture, client *http.Client, files []struct {
	name, content string
	mode          os.FileMode
}) *http.Response {
	t.Helper()
	var archive bytes.Buffer
	z := zip.NewWriter(&archive)
	for _, file := range files {
		h := &zip.FileHeader{Name: file.name, Method: zip.Deflate}
		if file.mode != 0 {
			h.SetMode(file.mode)
		}
		w, err := z.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(w, file.content); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	m := multipart.NewWriter(&body)
	w, err := m.CreateFormFile("file", "plugin.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(archive.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	return f.do(client, "POST", "/api/v1/plugins", body.String(), map[string]string{"Content-Type": m.FormDataContentType()})
}

func TestPluginInstallBoundariesAndData(t *testing.T) {
	f := newFixture(t)
	files := []struct {
		name, content string
		mode          os.FileMode
	}{
		{"manifest.json", `{"id":"sample","name":"示例","version":"1","apiVersion":1}`, 0},
		{"main.js", `import './lib.js'; export default function () {}`, 0},
		{"lib.js", `export const value = 1`, 0},
	}
	guest := newClient()
	if res := pluginUpload(t, f, guest, files); res.StatusCode != 401 {
		t.Fatalf("匿名安装得到 %d", res.StatusCode)
	}
	created := pluginUpload(t, f, f.admin, files)
	if created.StatusCode != 201 {
		t.Fatalf("安装失败：%d", created.StatusCode)
	}
	info := decode[pluginInfo](t, created)
	if info.Enabled || len(info.Revision) != 64 {
		t.Fatal("安装默认状态无效")
	}
	if res := pluginUpload(t, f, f.admin, files); res.StatusCode != 409 {
		t.Fatalf("重复安装得到 %d", res.StatusCode)
	}
	base := "/api/v1/plugins/sample"
	asset := base + "/assets/" + info.Revision + "/main.js"
	res := f.do(f.admin, "GET", asset, "", nil)
	content, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !strings.Contains(string(content), "import") || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/javascript") {
		t.Fatal("模块资源读取失败")
	}
	if code := f.status(guest, "GET", asset, "", nil); code != 401 {
		t.Fatalf("匿名资源得到 %d", code)
	}
	if code := f.status(f.admin, "GET", strings.Replace(asset, info.Revision, strings.Repeat("0", 64), 1), "", nil); code != 404 {
		t.Fatalf("过期资源得到 %d", code)
	}
	toggle := decode[pluginInfo](t, f.do(f.admin, "PATCH", base, `{"enabled":true}`, nil))
	if !toggle.Enabled {
		t.Fatal("插件未启用")
	}
	if code := f.status(f.admin, "PUT", base+"/data", `{"data":{"counter":2}}`, nil); code != 200 {
		t.Fatalf("保存数据得到 %d", code)
	}
	if code := f.status(f.admin, "DELETE", base, "", nil); code != 200 {
		t.Fatalf("卸载得到 %d", code)
	}
	if code := f.status(f.admin, "GET", asset, "", nil); code != 404 {
		t.Fatalf("卸载后资源得到 %d", code)
	}
	if res := pluginUpload(t, f, f.admin, files); res.StatusCode != 201 {
		t.Fatal("重新安装失败")
	}
	data := decode[struct{ Data map[string]int }](t, f.do(f.admin, "GET", base+"/data", "", nil))
	if data.Data["counter"] != 2 {
		t.Fatal("卸载丢失了插件数据")
	}
	for _, bad := range []struct {
		name, content string
		mode          os.FileMode
	}{
		{"../escape.js", "x", 0}, {"/absolute.js", "x", 0}, {"dir\\escape.js", "x", 0}, {"main.js", "重复", 0}, {"link.js", "main.js", os.ModeSymlink | 0o777},
	} {
		if res := pluginUpload(t, f, f.admin, append(files, bad)); res.StatusCode != 400 {
			t.Fatalf("非法包 %q 得到 %d", bad.name, res.StatusCode)
		}
	}
	large := append(files, struct {
		name, content string
		mode          os.FileMode
	}{"large.js", strings.Repeat("x", maxPluginExpanded), 0})
	if res := pluginUpload(t, f, f.admin, large); res.StatusCode != 400 {
		t.Fatalf("解压超限得到 %d", res.StatusCode)
	}
	// Even write-capable API tokens cannot install or read plugin code or private configuration.
	token := decode[struct{ Token string }](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"测试","scope":"write"}`, nil)).Token
	for _, target := range []string{"/api/v1/plugins", base + "/data", asset} {
		if code := f.status(guest, "GET", target, "", map[string]string{"Authorization": "Bearer " + token}); code != 403 {
			t.Fatalf("令牌访问插件得到 %d", code)
		}
	}
}
