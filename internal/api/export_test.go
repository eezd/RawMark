package api

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExportMarkdownAndReferencedAssets(t *testing.T) {
	f := newFixture(t)
	f.write("资料/文章.md", "# 标题\n![图片](../assets/图.png)\n`![](不存在.png)`\n[其他笔记](未选中.md)")
	if err := os.MkdirAll(filepath.Join(f.root, "assets"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, "assets/图.png"), []byte("图片内容"), 0644); err != nil {
		t.Fatal(err)
	}
	response := f.do(f.admin, "POST", "/api/v1/export", `{"paths":["资料/文章.md"]}`, nil)
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("导出失败：%d %s", response.StatusCode, data)
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, file := range reader.File {
		r, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, _ := io.ReadAll(r)
		r.Close()
		files[file.Name] = string(content)
	}
	if files["assets/图.png"] != "图片内容" || !strings.Contains(files["资料/文章.md"], "../assets/图.png") || len(files) != 2 {
		t.Fatalf("附件或目录不符：%v", files)
	}
	f.write("单篇.md", "原始 Markdown")
	response = f.do(f.admin, "POST", "/api/v1/export", `{"paths":["单篇.md"]}`, nil)
	defer response.Body.Close()
	data, _ = io.ReadAll(response.Body)
	if response.StatusCode != 200 || string(data) != "原始 Markdown" || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/markdown") {
		t.Fatalf("单篇导出不符：%d %s", response.StatusCode, data)
	}
}

func TestExportRejectsMissingAssetsAndSymlinks(t *testing.T) {
	f := newFixture(t)
	f.write("文章.md", "![](missing.png)")
	for _, body := range []string{`{"paths":["文章.md"]}`, `{"paths":[".rawmark/app.db"]}`, `{"paths":[]}`} {
		response := f.do(f.admin, "POST", "/api/v1/export", body, nil)
		response.Body.Close()
		if response.StatusCode == 200 {
			t.Fatalf("不应成功：%s", body)
		}
	}
	f.write("真实.md", "内容")
	if err := os.Symlink(filepath.Join(f.root, "真实.md"), filepath.Join(f.root, "别名.md")); err != nil {
		t.Fatal(err)
	}
	response := f.do(f.admin, "POST", "/api/v1/export", `{"paths":["别名.md"]}`, nil)
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatalf("应拒绝符号链接：%d", response.StatusCode)
	}
}

func TestReadTokenMayExportButCannotWrite(t *testing.T) {
	f := newFixture(t)
	f.write("文章.md", "原文")
	token := decode[struct{ Token string }](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"只读导出","scope":"read"}`, nil))
	headers := map[string]string{"Authorization": "Bearer " + token.Token}
	guest := newClient()
	if code := f.status(guest, "POST", "/api/v1/export", `{"paths":["文章.md"]}`, headers); code != 200 {
		t.Fatalf("只读导出被拒绝：%d", code)
	}
	if code := f.status(guest, "POST", "/api/v1/move", `{"from":"文章.md","to":"其他.md"}`, headers); code != 403 {
		t.Fatalf("只读令牌获得写权限：%d", code)
	}
}
