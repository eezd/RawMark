package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"rawmark/internal/vault"
	"testing"
)

func TestStorageCountsOwnedRootsOnce(t *testing.T) {
	for _, layout := range []string{"nested-vault", "external-vault", "nested-data", "same-root"} {
		t.Run(layout, func(t *testing.T) {
			root := t.TempDir()
			data, vault := filepath.Join(root, "data"), filepath.Join(root, "data", "vault")
			switch layout {
			case "external-vault":
				vault = filepath.Join(root, "external")
			case "nested-data":
				vault, data = root, filepath.Join(root, "app")
			case "same-root":
				vault = data
			}
			write := func(base, rel string, size int) {
				t.Helper()
				path := filepath.Join(base, rel)
				if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, make([]byte, size), 0600); err != nil {
					t.Fatal(err)
				}
			}
			write(vault, "note.md", 5)
			write(vault, "dir/assets/a.png", 7)
			write(vault, "old.assets/b.png", 11)
			write(vault, ".rawmark/trash/id/meta.json", 13)
			write(vault, ".rawmark/trash/id/assets/a.png", 17)
			write(data, "rawmark.db", 19)
			write(data, "index.db-wal", 23)
			write(data, "fonts/a/file.woff2", 29)
			write(data, "themes/a/theme.css", 31)
			write(data, "plugins/a/main.js", 37)
			write(data, "misc.bin", 41)
			outside := t.TempDir()
			write(outside, "outside.md", 1000)
			if err := os.Symlink(outside, filepath.Join(vault, "link")); err != nil {
				t.Fatal(err)
			}
			usage, err := scanStorage(context.Background(), data, vault)
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]int64{"vault": 53, "databases": 42, "fonts": 29, "themes": 31, "plugins": 37, "other": 41}
			if layout == "same-root" {
				want["vault"] += 41
				want["other"] = 0
			}
			for _, category := range usage.Categories {
				if category.Size != want[category.ID] {
					t.Errorf("%s = %d, want %d", category.ID, category.Size, want[category.ID])
				}
			}
			if usage.TotalSize != 233 || usage.AssetsSize != 18 || usage.TrashSize != 30 || usage.CalculatedAt <= 0 {
				t.Fatalf("总量或子项不符: %+v", usage)
			}
		})
	}
}

func TestStorageDoesNotReturnPartialSuccess(t *testing.T) {
	root := t.TempDir()
	if _, err := scanStorage(context.Background(), root, filepath.Join(root, "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("仓库缺失应报错: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := scanStorage(ctx, root, root); !errors.Is(err, context.Canceled) {
		t.Fatalf("请求取消应停止扫描: %v", err)
	}
}

func TestStorageIncludesOptionalAndImportedFontBytes(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "vault"), 0700)
	os.MkdirAll(filepath.Join(root, "fonts/custom"), 0700)
	os.WriteFile(filepath.Join(root, "fonts/custom/font.woff2"), make([]byte, 123), 0600)
	v, err := vault.Open(filepath.Join(root, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{DataDir: root, vault: v, BuiltinFontsSize: 456}
	recorder := httptest.NewRecorder()
	s.getStorage(recorder, httptest.NewRequest("GET", "/", nil))
	var envelope struct{ Data storageUsage }
	var usage storageUsage
	if err = json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	usage = envelope.Data
	if usage.BuiltinFontsSize != 456 || usage.CustomFontsSize != 123 || usage.Categories[2].Size != 579 {
		t.Fatalf("字体统计错误: %+v", usage)
	}
	var sum int64
	for _, category := range usage.Categories {
		sum += category.Size
	}
	if sum != usage.TotalSize {
		t.Fatal("分类与总量不一致")
	}
}
