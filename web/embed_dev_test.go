//go:build dev

package web

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDevelopmentMetadataDoesNotRequireBuild(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	themes := filepath.Join("web", "src", "common", "appearance")
	if err := os.MkdirAll(filepath.Join(themes, "fonts"), 0700); err != nil {
		t.Fatal(err)
	}
	css := `@font-face { src: url(./fonts/a.woff2); }
@font-face { src: url('./fonts/a.woff2'); }
@font-face { src: url("./fonts/b.woff2"); }`
	if err := os.WriteFile(filepath.Join(themes, "fonts.css"), []byte(css), 0600); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{"a.woff2": "abc", "b.woff2": "defgh"} {
		if err := os.WriteFile(filepath.Join(themes, "fonts", name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	version, err := BuildVersion()
	if err != nil || version != "dev" {
		t.Fatalf("开发版本不应依赖构建产物：%q，%v", version, err)
	}
	size, err := FontStorage()
	if err != nil || size != 8 {
		t.Fatalf("开发字体统计应按源文件去重：%d，%v", size, err)
	}
	if err = os.Remove(filepath.Join(themes, "fonts", "b.woff2")); err != nil {
		t.Fatal(err)
	}
	if _, err = FontStorage(); err == nil {
		t.Fatal("字体源文件缺失时不得返回零值伪装成功")
	}
}
