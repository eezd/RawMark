package vault

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanupChecksFreshReferencesAndShares(t *testing.T) {
	v := newVault(t)
	if _, err := v.Write("a.md", []byte("[图片](assets/used.png)"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"assets/used.png", "assets/orphan.png", "public/shared.png", "a.assets/attached.png"} {
		full := filepath.Join(v.Root(), p)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("image"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	result, err := v.CleanupImages([]string{"assets/used.png", "assets/orphan.png", "public/shared.png", "a.assets/attached.png", "../outside.png"}, func() ([]string, error) { return []string{"public", "a.md"}, nil })
	if err != nil || len(result.Deleted) != 1 || result.Deleted[0].Path != "assets/orphan.png" || len(result.Skipped) != 4 {
		t.Fatalf("清理结果不符：%+v %v", result, err)
	}
	if _, err := v.Restore(result.Deleted[0].ID); err != nil {
		t.Fatal("孤立图片不能恢复", err)
	}
	if _, err := v.Write("a.md", []byte("---\ntags: [broken\n---"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	result, err = v.CleanupImages([]string{"assets/orphan.png"}, func() ([]string, error) { return nil, nil })
	if err == nil || len(result.Deleted) != 0 {
		t.Fatal("不完整的引用分析不能删除图片", result, err)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), "assets/orphan.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Write("a.md", []byte(""), Precondition{}); err != nil {
		t.Fatal(err)
	}
	cause := errors.New("分享读取失败")
	_, err = v.CleanupImages([]string{"assets/orphan.png"}, func() ([]string, error) { return nil, cause })
	if !errors.Is(err, cause) {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), "assets/orphan.png")); err != nil {
		t.Fatal("分享校验失败后不应删除", err)
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
