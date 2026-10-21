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

func TestExportDoesNotTreatTextAndFootnotesAsAssets(t *testing.T) {
	for _, content := range []string{
		"普通文字 ](private.png)\n",
		"正文[^1]\n\n[^1]: private.png\n",
		"\\[转义文字](private.png)\n",
		"[未闭合链接](private.png\n",
		"`[代码](private.png)`\n",
		"正文[^1]\n\n[^1]: 这是脚注内容。\n",
	} {
		t.Run(content, func(t *testing.T) {
			f := newFixture(t)
			f.write("文章.md", content)
			if err := os.WriteFile(filepath.Join(f.root, "private.png"), []byte("未选中的私有文件"), 0644); err != nil {
				t.Fatal(err)
			}
			response := f.do(f.admin, "POST", "/api/v1/export", `{"paths":["文章.md"]}`, nil)
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/markdown") || string(body) != content {
				t.Fatalf("应只导出原文，不夹带无关文件：%d %s", response.StatusCode, body)
			}
		})
	}
}

func TestExportIncludesAssetsInMultilineLinksAndContainers(t *testing.T) {
	for _, content := range []string{
		"![图片](\nassets/image.png\n)\n",
		"> ![图片](\n> assets/image.png\n> )\n",
		"> ![图片][pic]\n>\n> [pic]: assets/image.png\n",
		"> > ![图片][pic]\n> >\n> > [pic]: assets/image.png\n",
		"- ![图片][pic]\n\n  [pic]: assets/image.png\n",
		"![图片][pic]\n\n[pic]:\n  assets/image.png \"说明\"\n",
		"正文[^1]\n\n[^1]: ![图片](assets/image.png)\n",
		"![图片][pic]\n\n[pic]: assets/image.png \"[不是链接](private.png)\"\n",
		"![图片][pic]\n\n[pic]: assets/image.png\n  \"[不是链接](private.png)\"\n",
		"![图片][pic]\n\n[pic]: assets/image.png \"说明\n[fake]: private.png\n\"\n",
	} {
		t.Run(content, func(t *testing.T) {
			f := newFixture(t)
			f.write("文章.md", content)
			if err := os.MkdirAll(filepath.Join(f.root, "assets"), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(f.root, "assets/image.png"), []byte("图片内容"), 0644); err != nil {
				t.Fatal(err)
			}
			response := f.do(f.admin, "POST", "/api/v1/export", `{"paths":["文章.md"]}`, nil)
			defer response.Body.Close()
			data, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != 200 {
				t.Fatalf("导出失败：%d %s", response.StatusCode, data)
			}
			reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
			if err != nil {
				t.Fatal("附件不应被漏收：", err)
			}
			files := map[string]string{}
			for _, file := range reader.File {
				r, err := file.Open()
				if err != nil {
					t.Fatal(err)
				}
				body, err := io.ReadAll(r)
				r.Close()
				if err != nil {
					t.Fatal(err)
				}
				files[file.Name] = string(body)
			}
			if len(files) != 2 || files["文章.md"] != content || files["assets/image.png"] != "图片内容" {
				t.Fatalf("原文或附件不符：%v", files)
			}
		})
	}
}
