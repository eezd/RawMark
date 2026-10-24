package vault

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type zipEntry struct {
	name, content string
	mode          fs.FileMode
}

func importZip(t *testing.T, entries ...zipEntry) ImportFile {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.mode != 0 {
			h.SetMode(e.mode)
		}
		f, err := w.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(e.content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	data := b.Bytes()
	return ImportFile{Name: "知识库.md.zip", Reader: bytes.NewReader(data), Size: int64(len(data))}
}

func markdownFile(name, content string) ImportFile {
	return ImportFile{Name: name, Reader: strings.NewReader(content), Size: int64(len(content))}
}

func TestImportZipAssetsAndMove(t *testing.T) {
	v := newVault(t)
	content := "# 标题\n\n![图](<assets/图 (1).png> \"说明\")\n\n![引用][图]\n\n[图]: assets/图%20(1).png\n\n<img src=\"assets/图%20(1).png\">\n\n[子笔记](子目录/子笔记.md)\n\n![外链](https://example.com/a.png)\n\n![缺失](assets/missing.png)\n\n`![代码](assets/图%20(1).png)`\n\n```md\n![代码块](assets/图%20(1).png)\n```\n\n> ```\n> ![引用代码](assets/图%20(1).png)\n> ```\n\n    ![缩进代码](assets/图%20(1).png)\n"
	source := importZip(t, zipEntry{name: "目录/笔记.md", content: content}, zipEntry{name: "目录/子目录/子笔记.md", content: "# 子笔记"}, zipEntry{name: "目录/assets/图 (1).png", content: "image"}, zipEntry{name: "未引用.txt", content: "附件"})
	result, err := v.Import(context.Background(), "", "知识库", []ImportFile{source})
	if err != nil {
		t.Fatal(err)
	}
	if result.Notes != 2 || result.Assets != 2 || len(result.Warnings) != 1 || len(result.Paths) != 1 || result.Paths[0] != "知识库" {
		t.Fatalf("结果不符: %+v", result)
	}
	body, _, err := v.Read("知识库/目录/笔记.md")
	if err != nil {
		t.Fatal(err)
	}
	link := "./assets/" + assetName([]byte("image"), "x.png")
	expected := strings.Replace(content, "<assets/图 (1).png>", "<"+link+">", 1)
	expected = strings.Replace(expected, "[图]: assets/图%20(1).png", "[图]: "+link, 1)
	expected = strings.Replace(expected, "src=\"assets/图%20(1).png\"", "src=\""+link+"\"", 1)
	if string(body) != expected {
		t.Fatalf("正文变更不符:\n%s", body)
	}
	if err := v.Mkdir("移动目标"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Move("知识库/目录/笔记.md", "移动目标/改名.md"); err != nil {
		t.Fatal(err)
	}
	moved, _, err := v.Read("移动目标/改名.md")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(moved), "./assets/") {
		t.Fatal("图片链接未跟随改名")
	}
	if _, err := os.Stat(filepath.Join(v.root, "移动目标/assets", assetName([]byte("image"), "x.png"))); err != nil {
		t.Fatal("附件未跟随", err)
	}
	if _, err := os.Stat(filepath.Join(v.root, "知识库/目录/assets/图 (1).png")); !os.IsNotExist(err) {
		t.Fatal("已迁移的重复原图应移除", err)
	}
}

func TestImportPreservesContainersAndOnlyRewritesActualLinks(t *testing.T) {
	v := newVault(t)
	content := "> ![图片][pic]\r\n>\r\n> [pic]: assets/image.png \"[示例](private.png)\"\r\n\n![跨行](\nassets/image.png\n)\n\n普通文字 ](private.png)\n\n[^1]: missing.png\n\n`![代码](assets/image.png)`\n"
	source := importZip(t,
		zipEntry{name: "文章.md", content: content},
		zipEntry{name: "assets/image.png", content: "image"},
		zipEntry{name: "private.png", content: "private"},
	)
	result, err := v.Import(context.Background(), "", "导入", []ImportFile{source})
	if err != nil {
		t.Fatal(err)
	}
	if result.Notes != 1 || result.Assets != 2 || len(result.Warnings) != 0 {
		t.Fatalf("仅真实图片应生成附件副本，脚注正文不应产生缺失警告：%+v", result)
	}
	body, _, err := v.Read("导入/文章.md")
	if err != nil {
		t.Fatal(err)
	}
	link := "./assets/" + assetName([]byte("image"), "x.png")
	want := strings.Replace(content, "[pic]: assets/image.png", "[pic]: "+link, 1)
	want = strings.Replace(want, "![跨行](\nassets/image.png", "![跨行](\n"+link, 1)
	if string(body) != want {
		t.Fatalf("应只改写真实链接并保留原文格式：\n%s\n期望：\n%s", body, want)
	}
}

func TestImportRejectsInvalidWithoutPublishing(t *testing.T) {
	for _, tc := range []struct {
		name    string
		entries []zipEntry
		want    error
	}{
		{"越界", []zipEntry{{name: "../outside.md", content: "x"}}, ErrInvalidImport},
		{"隐藏路径", []zipEntry{{name: ".rawmark/x.md", content: "x"}}, ErrInvalidImport},
		{"重复路径", []zipEntry{{name: "a.md", content: "x"}, {name: "a.md", content: "y"}}, ErrInvalidImport},
		{"符号链接", []zipEntry{{name: "a.md", content: "x", mode: os.ModeSymlink | 0o777}}, ErrInvalidImport},
		{"目录文件冲突", []zipEntry{{name: "a/"}, {name: "a", content: "x"}, {name: "b.md", content: "x"}}, ErrInvalidImport},
		{"文件目录冲突反向", []zipEntry{{name: "a", content: "x"}, {name: "a/"}, {name: "b.md", content: "x"}}, ErrInvalidImport},
		{"无笔记", []zipEntry{{name: "a.png", content: "x"}}, ErrInvalidImport},
		{"非法编码", []zipEntry{{name: "a.md", content: "\xff"}}, ErrInvalidImport},
		{"附件目录内笔记", []zipEntry{{name: "a.assets/a.md", content: "x"}}, ErrInvalidImport},
		{"文件目录冲突", []zipEntry{{name: "a", content: "x"}, {name: "a/b.md", content: "y"}}, ErrInvalidImport},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := newVault(t)
			_, err := v.Import(context.Background(), "", "导入", []ImportFile{importZip(t, tc.entries...)})
			if !errors.Is(err, tc.want) {
				t.Fatalf("错误不符: %v", err)
			}
			entries, err := os.ReadDir(v.root)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 || entries[0].Name() != metaDir {
				t.Fatal("失败后留下可见内容或临时目录")
			}
		})
	}
}

func TestImportBatchConflictAndCancellation(t *testing.T) {
	v := newVault(t)
	if _, err := v.Write("b.md", []byte("原文"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	sources := []ImportFile{markdownFile("a.md", "新文"), markdownFile("b.md", "覆盖")}
	if _, err := v.Import(context.Background(), "", "", sources); !errors.Is(err, ErrExists) {
		t.Fatal(err)
	}
	if _, _, err := v.Read("a.md"); !errors.Is(err, ErrNotFound) {
		t.Fatal("批量冲突产生了半成品", err)
	}
	body, _, _ := v.Read("b.md")
	if string(body) != "原文" {
		t.Fatal("原文件被覆盖")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := v.Import(ctx, "", "", sources[:1]); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := v.Import(context.Background(), "不存在", "", sources[:1]); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	result, err := v.Import(context.Background(), "", "", []ImportFile{markdownFile("a.md", "\xef\xbb\xbf正文"), markdownFile("c.md", "![缺图](local.png)")})
	if err != nil || result.Notes != 2 || len(result.Warnings) != 1 {
		t.Fatalf("结果不符: %+v %v", result, err)
	}
	body, _, _ = v.Read("a.md")
	if string(body) != "正文" {
		t.Fatal("UTF-8 BOM 未处理")
	}
}

func TestImportLimitsAndCorruptZip(t *testing.T) {
	v := newVault(t)
	source := markdownFile("large.md", strings.Repeat("a", importNoteLimit+1))
	if _, err := v.Import(context.Background(), "", "", []ImportFile{source}); !errors.Is(err, ErrTooLarge) {
		t.Fatal(err)
	}
	source.Size = MaxImportBytes + 1
	if _, err := v.Import(context.Background(), "", "", []ImportFile{source}); !errors.Is(err, ErrTooLarge) {
		t.Fatal(err)
	}
	broken := markdownFile("broken.zip", "not zip")
	if _, err := v.Import(context.Background(), "", "导入", []ImportFile{broken}); !errors.Is(err, ErrInvalidImport) {
		t.Fatal(err)
	}
}

func TestImportCorruptZipContent(t *testing.T) {
	v := newVault(t)
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	f, err := writer.CreateHeader(&zip.FileHeader{Name: "n.md", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("unique markdown payload")
	if _, err := f.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	data := buffer.Bytes()
	offset := bytes.Index(data, payload)
	if offset < 0 {
		t.Fatal("找不到测试负载")
	}
	data[offset] ^= 1
	_, err = v.Import(context.Background(), "", "损坏", []ImportFile{{Name: "broken.zip", Reader: bytes.NewReader(data), Size: int64(len(data))}})
	if !errors.Is(err, ErrInvalidImport) {
		t.Fatalf("应拒绝 CRC 损坏: %v", err)
	}
	if _, err := os.Stat(filepath.Join(v.root, "损坏")); !os.IsNotExist(err) {
		t.Fatal("损坏内容被发布", err)
	}
}
