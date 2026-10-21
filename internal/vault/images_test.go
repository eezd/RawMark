package vault

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImageMoveUpdatesLocalReferences(t *testing.T) {
	v := newVault(t)
	if err := os.MkdirAll(filepath.Join(v.Root(), "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(v.Root(), "assets/原图.png"), []byte("image"), 0o644); err != nil {
		t.Fatal(err)
	}
	content := "![图](../assets/原图.png?q=1#part \"标题\")\n[ref]: <../assets/原图.png>\n<img src=\"../assets/原图.png?q=1&amp;x=2\">\n`![](../assets/原图.png)`\n\n```md\n![](../assets/原图.png)\n```\n![](https://example.com/assets/原图.png)\n![](../assets/其他.png)\n"
	if _, err := v.Write("notes/a.md", []byte(content), Precondition{}); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Move("assets/原图.png", "elsewhere/新图 #.png", nil); err != nil {
		t.Fatal(err)
	}
	out, _, err := v.Read("notes/a.md")
	if err != nil {
		t.Fatal(err)
	}
	want := strings.ReplaceAll(content, "../assets/原图.png", "../elsewhere/新图%20%23.png")
	want = strings.ReplaceAll(want, "`![](../elsewhere/新图%20%23.png)`", "`![](../assets/原图.png)`")
	want = strings.ReplaceAll(want, "```md\n![](../elsewhere/新图%20%23.png)", "```md\n![](../assets/原图.png)")
	if string(out) != want {
		t.Fatalf("链接改写不符：\n%s\n期望：\n%s", out, want)
	}
	if _, err := v.Move("elsewhere/新图 #.png", "elsewhere/新图.jpg", nil); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("不能用重命名改变图片格式：%v", err)
	}
	item, err := v.Delete("elsewhere/新图 #.png")
	if err != nil {
		t.Fatal(err)
	}
	if item.Assets != "" {
		t.Fatal("图片不应带走同名笔记附件目录")
	}
	if _, err := v.Restore(item.ID); err != nil {
		t.Fatal(err)
	}
	f, _, err := v.OpenRaw("elsewhere/新图 #.png")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
}

func TestReplaceImagePreservesPathAndUploadContents(t *testing.T) {
	v := newVault(t)
	link, err := v.SaveAsset("a.md", "old.png", strings.NewReader("original"), 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := v.ReplaceImage(link, "replacement.PNG", strings.NewReader("replacement"), 100); err != nil {
		t.Fatal(err)
	}
	newLink, err := v.SaveAsset("a.md", "old.png", strings.NewReader("original"), 100)
	if err != nil {
		t.Fatal(err)
	}
	again, err := v.SaveAsset("a.md", "old.png", strings.NewReader("original"), 100)
	if err != nil || again != newLink || newLink == link {
		t.Fatalf("替换后的去重不符：%q %q %q %v", link, newLink, again, err)
	}
	for name, want := range map[string]string{link: "replacement", newLink: "original"} {
		data, err := os.ReadFile(filepath.Join(v.Root(), name))
		if err != nil || string(data) != want {
			t.Fatalf("图片内容错误：%q %q %v", name, data, err)
		}
	}
	for _, tc := range []struct {
		path, name, data string
		limit            int64
		want             error
	}{
		{link, "x.jpg", "new", 100, ErrInvalidPath},
		{link, "x.png", "", 100, ErrInvalidPath},
		{link, "x.png", "too big", 1, ErrTooLarge},
		{"missing.png", "x.png", "new", 100, ErrNotFound},
		{"../escape.png", "x.png", "new", 100, ErrInvalidPath},
		{"a.md", "x.md", "new", 100, ErrInvalidPath},
	} {
		if err := v.ReplaceImage(tc.path, tc.name, strings.NewReader(tc.data), tc.limit); !errors.Is(err, tc.want) {
			t.Errorf("替换 %s：得到 %v，期望 %v", tc.path, err, tc.want)
		}
	}
	data, err := os.ReadFile(filepath.Join(v.Root(), link))
	if err != nil || string(data) != "replacement" {
		t.Fatalf("无效替换不能影响原图：%q %v", data, err)
	}
}

func TestImagesDoNotExposeOrModifySymlinks(t *testing.T) {
	v := newVault(t)
	outside := filepath.Join(t.TempDir(), "private.png")
	if err := os.WriteFile(outside, []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(v.Root(), "link.png")); err != nil {
		t.Fatal(err)
	}
	entries, err := v.Tree()
	if err != nil || len(entries) != 0 {
		t.Fatalf("图片列表不应公开符号链接：%v %v", entries, err)
	}
	if err := v.ReplaceImage("link.png", "x.png", strings.NewReader("new"), 100); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("不能替换仓库外文件：%v", err)
	}
}

func TestMoveCommitFailureRestoresExactReferences(t *testing.T) {
	for _, source := range []string{"from.png", "from.md"} {
		t.Run(source, func(t *testing.T) {
			v := newVault(t)
			content := "![](from.assets/a.png)"
			if _, err := v.Write("from.md", []byte(content), Precondition{}); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(filepath.Join(v.Root(), "from.assets"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(v.Root(), "from.png"), []byte("image"), 0o644); err != nil {
				t.Fatal(err)
			}
			refs := "![](from.png)\n![](to.png)"
			if _, err := v.Write("refs.md", []byte(refs), Precondition{}); err != nil {
				t.Fatal(err)
			}
			failure := errors.New("关联数据提交失败")
			target := strings.Replace(source, "from", "to", 1)
			if _, err := v.Move(source, target, func() error { return failure }); !errors.Is(err, failure) {
				t.Fatal(err)
			}
			for name, want := range map[string]string{"from.md": content, "refs.md": refs} {
				got, _, err := v.Read(name)
				if err != nil || string(got) != want {
					t.Fatalf("回滚须保留原始正文：%s %q %v", name, got, err)
				}
			}
			if _, err := os.Stat(filepath.Join(v.Root(), target)); !os.IsNotExist(err) {
				t.Fatalf("失败后目标仍存在：%v", err)
			}
			if _, err := os.Stat(filepath.Join(v.Root(), "from.assets")); err != nil {
				t.Fatal(err)
			}
		})
	}
}
