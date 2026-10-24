package vault

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanupChecksFreshReferences(t *testing.T) {
	v := newVault(t)
	if _, err := v.Write("a.md", []byte("[图片](assets/used.png)"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"assets/used.png", "assets/orphan.png", "public/orphan.png", "a.assets/attached.png"} {
		full := filepath.Join(v.Root(), p)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("image"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	result, err := v.CleanupImages([]string{"assets/used.png", "assets/orphan.png", "public/orphan.png", "a.assets/attached.png", "../outside.png"})
	if err != nil || len(result.Deleted) != 3 || result.Deleted[0].Path != "assets/orphan.png" || len(result.Skipped) != 2 {
		t.Fatalf("清理结果不符：%+v %v", result, err)
	}
	if _, err := v.Restore(result.Deleted[0].ID); err != nil {
		t.Fatal("孤立图片不能恢复", err)
	}
	if _, err := v.Write("a.md", []byte("---\ntags: [broken\n---"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	result, err = v.CleanupImages([]string{"assets/orphan.png"})
	if err == nil || len(result.Deleted) != 0 {
		t.Fatal("不完整的引用分析不能删除图片", result, err)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), "assets/orphan.png")); err != nil {
		t.Fatal(err)
	}
}

func TestFolderUploadReusesDeduplication(t *testing.T) {
	v := newVault(t)
	first, err := v.SaveFolderAsset("", "a.png", strings.NewReader("image"), 10)
	if err != nil {
		t.Fatal(err)
	}
	second, err := v.SaveFolderAsset("", "b.png", strings.NewReader("image"), 10)
	if err != nil || first != second || !strings.HasPrefix(first, "assets/") {
		t.Fatalf("文件夹上传未去重：%s %s %v", first, second, err)
	}
	if _, err := v.SaveFolderAsset("missing", "a.png", strings.NewReader("image"), 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("目标目录不存在应报错：%v", err)
	}
}

func TestCleanupProtectsLinkedImages(t *testing.T) {
	for _, style := range []string{"内联链接", "引用式链接"} {
		t.Run(style, func(t *testing.T) {
			v := newVault(t)
			link, err := v.SaveFolderAsset("", "preview.png", strings.NewReader("image"), 100)
			if err != nil {
				t.Fatal(err)
			}
			content := "[![预览](" + link + ")](https://example.com)"
			if style == "引用式链接" {
				content = "[![预览][image]][site]\n\n[image]: " + link + "\n[site]: https://example.com\n"
			}
			if _, err := v.Write("a.md", []byte(content), Precondition{}); err != nil {
				t.Fatal(err)
			}
			metadata := Analyze("a.md", []byte(content))
			if len(metadata.Assets) != 1 || metadata.Assets[0].Target != link {
				t.Fatalf("链接内图片未记录引用：%+v", metadata)
			}
			result, err := v.CleanupImages([]string{link})
			if err != nil || len(result.Deleted) != 0 || len(result.Skipped) != 1 || result.Skipped[0].Reason != "仍被笔记引用" {
				t.Fatalf("链接内图片未受保护：%+v %v", result, err)
			}
			if _, err := v.Stat(link); err != nil {
				t.Fatal("正文引用的图片不应被移走", err)
			}
		})
	}
}
