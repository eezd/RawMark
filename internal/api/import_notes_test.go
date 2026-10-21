package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rawmark/internal/vault"
)

func TestImportNotesAPI(t *testing.T) {
	f := newFixture(t)
	send := func(client *http.Client, token, dir, folder, name string, data []byte) *http.Response {
		t.Helper()
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		if err := form.WriteField("dir", dir); err != nil {
			t.Fatal(err)
		}
		if err := form.WriteField("folder", folder); err != nil {
			t.Fatal(err)
		}
		file, err := form.CreateFormFile("files", name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(data); err != nil {
			t.Fatal(err)
		}
		if err := form.Close(); err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest("POST", f.url+"/api/v1/import", &body)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", form.FormDataContentType())
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	readToken := decode[struct{ Token string }](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"只读","scope":"read"}`, nil)).Token
	for _, tc := range []struct {
		client *http.Client
		token  string
		status int
	}{{newClient(), "", 401}, {newClient(), readToken, 403}} {
		res := send(tc.client, tc.token, "", "", "n.md", []byte("正文"))
		res.Body.Close()
		if res.StatusCode != tc.status {
			t.Fatalf("权限状态不符: %d", res.StatusCode)
		}
	}
	res := send(f.admin, "", "", "", "n.md", []byte("正文"))
	if res.StatusCode != 201 {
		t.Fatalf("导入失败: %d", res.StatusCode)
	}
	var result vault.ImportResult
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if result.Notes != 1 || len(result.Paths) != 1 || result.Paths[0] != "n.md" || result.Warnings == nil {
		t.Fatalf("响应不符: %+v", result)
	}
	res = send(f.admin, "", "", "", "n.md", []byte("覆盖"))
	res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatalf("应拒绝冲突: %d", res.StatusCode)
	}
	data, err := os.ReadFile(filepath.Join(f.root, "n.md"))
	if err != nil || string(data) != "正文" {
		t.Fatal("原文被覆盖", err)
	}
	writeToken := decode[struct{ Token string }](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"写入","scope":"write"}`, nil)).Token
	var b bytes.Buffer
	zw := zip.NewWriter(&b)
	zf, err := zw.Create("子目录/笔记.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(zf, "# ZIP"); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	res = send(newClient(), writeToken, "", "知识库", "export.md.zip", b.Bytes())
	res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatalf("写入令牌导入失败: %d", res.StatusCode)
	}
	for _, tc := range []struct {
		dir, folder, name, data string
		status                  int
	}{
		{"", "", "x.zip", "invalid", 400}, {"不存在", "", "x.md", "x", 404}, {"n.md", "", "x.md", "x", 400}, {"", "", "x.md", strings.Repeat("a", (20<<20)+1), 413},
	} {
		res := send(f.admin, "", tc.dir, tc.folder, tc.name, []byte(tc.data))
		res.Body.Close()
		if res.StatusCode != tc.status {
			t.Fatalf("%s 状态不符: %d", tc.name, res.StatusCode)
		}
	}
}
