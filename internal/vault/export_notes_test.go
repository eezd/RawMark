package vault

import (
	"archive/zip"
	"context"
	"io"
	"os"
	"strings"
	"testing"
)

func TestExportNotesKeepsMarkdownAndReportsMissingAssets(t *testing.T) {
	v := newVault(t)
	source := "# 原文\n![](assets/a.png)\n![](missing.png)\n"
	if _, err := v.Write("note.md", []byte(source), Precondition{}); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Write("other.md", []byte("trash"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	v.Delete("other.md")
	v.SaveAsset("note.md", "a.png", strings.NewReader("image"), 50<<20)
	file, err := v.ExportNotes(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(file.Name())
	defer file.Close()
	info, _ := file.Stat()
	z, err := zip.NewReader(file, info.Size())
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]string{}
	for _, f := range z.File {
		if f.FileInfo().IsDir() {
			continue
		}
		r, _ := f.Open()
		body, err := io.ReadAll(r)
		r.Close()
		if err != nil {
			t.Fatal(err)
		}
		seen[f.Name] = string(body)
	}
	if seen["note.md"] != source {
		t.Fatal("导出改写了正文")
	}
	if _, ok := seen["other.md"]; ok {
		t.Fatal("不应导出回收站")
	}
	if !strings.Contains(seen[".rawmark-export/missing-assets.json"], "missing.png") {
		t.Fatal("未报告缺失附件")
	}
	target := newVault(t)
	if _, err = target.Import(context.Background(), "", "restored", []ImportFile{{Name: "notes.zip", Reader: file, Size: info.Size()}}); err != nil {
		t.Fatalf("导出包不能导回: %v", err)
	}
}

func TestExportNotesExcludesItsOwnOutputInsideVault(t *testing.T) {
	v := newVault(t)
	t.Setenv("TMPDIR", v.Root())
	t.Setenv("TMP", v.Root())
	t.Setenv("TEMP", v.Root())
	if _, err := v.Write("note.md", []byte("source"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	file, err := v.ExportNotes(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(file.Name())
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	z, err := zip.NewReader(file, info.Size())
	if err != nil {
		t.Fatal(err)
	}
	if len(z.File) != 1 || z.File[0].Name != "note.md" {
		t.Fatal("导出包含自身临时文件")
	}
}
