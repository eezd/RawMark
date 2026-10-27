package vault

import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func newVault(t *testing.T) *Vault {
	t.Helper()
	v, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// Construct legacy dedicated attachments explicitly to cover moves and recycle-bin restores after upgrading.
func legacyAsset(t *testing.T, v *Vault, note, name, content string) string {
	t.Helper()
	dir := filepath.Join(v.Root(), filepath.FromSlash(AssetsDir(note)))
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	file := assetName([]byte(content), name)
	if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return EscapeLinkPath(filepath.Base(dir)) + "/" + file
}

func TestCleanPathRejectsUnsafe(t *testing.T) {
	for _, p := range []string{"", "/a.md", "../a.md", "a/../b.md", "a//b.md", "./a.md", ".rawmark/x.md", "a/.git/b.md", "a\\b.md", "a\x00.md"} {
		if _, err := CleanPath(p); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("%q 应被拒绝", p)
		}
	}
	for _, p := range []string{"a.md", "目录/笔记 1.md", "a/b/c.md"} {
		if _, err := CleanPath(p); err != nil {
			t.Errorf("%q 应被接受: %v", p, err)
		}
	}
}

func TestSymlinkEscapeRejected(t *testing.T) {
	v := newVault(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(v.Root(), "link")); err != nil {
		t.Skip("无法创建符号链接:", err)
	}
	if _, err := v.Write("link/x.md", []byte("x"), Precondition{}); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("经符号链接写到仓库外应被拒绝, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "x.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("仓库外出现了文件")
	}
}

func TestAssetSymlinkEscapeRejected(t *testing.T) {
	v := newVault(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(v.Root(), "assets")); err != nil {
		t.Fatal(err)
	}
	if _, err := v.SaveAsset("n.md", "x.png", strings.NewReader("image"), 100); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("资源目录越界应被拒绝: %v", err)
	}
	files, err := os.ReadDir(outside)
	if err != nil || len(files) != 0 {
		t.Fatalf("仓库外被写入: %v %v", files, err)
	}
}

func TestMoveRollsBackWhenAssetDestinationIsTooLong(t *testing.T) {
	v := newVault(t)
	content := "原文 ![](n.assets/x.png)"
	if _, err := v.Write("n.md", []byte(content), Precondition{}); err != nil {
		t.Fatal(err)
	}
	refs := "[原文](n.md) [目标](" + strings.Repeat("a", 250) + ".md)"
	if _, err := v.Write("refs.md", []byte(refs), Precondition{}); err != nil {
		t.Fatal(err)
	}
	legacyAsset(t, v, "n.md", "x.png", "image")
	// The note name fits, but its derived .assets name exceeds the filesystem's per-segment length limit.
	destination := strings.Repeat("a", 250) + ".md"
	if _, err := v.Move("n.md", destination); err == nil {
		t.Fatal("图片目录移动应失败")
	}
	for name, want := range map[string]string{"n.md": content, "refs.md": refs} {
		if got, _, err := v.Read(name); err != nil || string(got) != want {
			t.Fatalf("原笔记与引用未恢复: %s %q %v", name, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(v.Root(), "n.assets")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.Read(destination); !errors.Is(err, ErrNotFound) {
		t.Fatalf("目标笔记应撤回: %v", err)
	}
}

func TestRestoreRollsBackWhenAssetsAreMissing(t *testing.T) {
	v := newVault(t)
	if _, err := v.Write("n.md", []byte("原文"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	legacyAsset(t, v, "n.md", "x.png", "image")
	item, err := v.Delete("n.md")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(v.trash, item.ID, item.Assets)); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Restore(item.ID); err == nil {
		t.Fatal("丢失图片目录时恢复应失败")
	}
	if _, _, err := v.Read("n.md"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不应留下部分恢复的笔记: %v", err)
	}
	items, err := v.TrashList()
	if err != nil || len(items) != 1 {
		t.Fatalf("回收站恢复依据未保留: %v %v", items, err)
	}
}

func TestAssetLinksWithReservedNotePath(t *testing.T) {
	v := newVault(t)
	folder := "目录 #?%20"
	if runtime.GOOS == "windows" {
		folder = "目录 #%20"
	}
	link, err := v.SaveAsset(folder+"/n.md", "x.png", strings.NewReader("image"), 100)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := url.PathUnescape(link)
	if err != nil {
		t.Fatal(err)
	}
	file, _, err := v.OpenRaw(filepath.ToSlash(filepath.Join(folder, decoded)))
	if err != nil {
		t.Fatalf("资源链接未指向实际文件: %s %v", link, err)
	}
	file.Close()
	if strings.ContainsAny(link, "#?") || !strings.HasPrefix(link, "./assets/") {
		t.Fatalf("链接未正确转义: %s", link)
	}
}

func TestWritePreconditions(t *testing.T) {
	v := newVault(t)
	rev, err := v.Write("a/b.md", []byte("one"), Precondition{IfNoneMatch: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Write("a/b.md", []byte("x"), Precondition{IfNoneMatch: true}); !errors.Is(err, ErrExists) {
		t.Fatalf("重复创建应失败, got %v", err)
	}
	var conflict *ConflictError
	if _, err := v.Write("a/b.md", []byte("x"), Precondition{IfMatch: "stale"}); !errors.As(err, &conflict) || conflict.Rev != rev {
		t.Fatalf("旧版本写入应返回冲突与当前版本, got %v", err)
	}
	rev2, err := v.Write("a/b.md", []byte("two"), Precondition{IfMatch: rev})
	if err != nil {
		t.Fatal(err)
	}
	data, got, err := v.Read("a/b.md")
	if err != nil || string(data) != "two" || got != rev2 {
		t.Fatalf("读取结果不符: %q %s %v", data, got, err)
	}
	if _, err := v.Write("a.txt", []byte("x"), Precondition{}); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("非 .md 文件应被拒绝")
	}
}

func TestMoveCarriesAssetsAndRewritesLinks(t *testing.T) {
	v := newVault(t)
	src := "笔记 A.md\n![](笔记%20A.assets/x.png)\n![](./笔记 A.assets/y.png)\n```\n![](笔记%20A.assets/code.png)\n```\n`笔记%20A.assets/inline`\n"
	if _, err := v.Write("dir/笔记 A.md", []byte(src), Precondition{}); err != nil {
		t.Fatal(err)
	}
	link := legacyAsset(t, v, "dir/笔记 A.md", "x.png", "png")
	if !strings.HasPrefix(link, "笔记%20A.assets/") {
		t.Fatalf("资源链接不符: %s", link)
	}
	if rewritten, err := v.Move("dir/笔记 A.md", "other/B.md"); err != nil || !rewritten {
		t.Fatalf("应报告正文改写: %v %v", rewritten, err)
	}
	data, _, err := v.Read("other/B.md")
	if err != nil {
		t.Fatal(err)
	}
	want := "笔记 A.md\n![](B.assets/x.png)\n![](./B.assets/y.png)\n```\n![](笔记%20A.assets/code.png)\n```\n`笔记%20A.assets/inline`\n"
	if string(data) != want {
		t.Fatalf("链接改写不符:\n%s", data)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), "other", "B.assets", strings.TrimPrefix(link, "笔记%20A.assets/"))); err != nil {
		t.Fatal("图片目录未随笔记移动:", err)
	}
	if _, err := v.Move("other", "other/sub"); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("文件夹移入自身应被拒绝")
	}
}

func TestDeleteRestore(t *testing.T) {
	v := newVault(t)
	v.Write("n.md", []byte("x"), Precondition{})
	legacyAsset(t, v, "n.md", "a.png", "img")
	item, err := v.Delete("n.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), "n.assets")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("图片目录应一并移入回收站")
	}
	items, _ := v.TrashList()
	if len(items) != 1 || items[0].ID != item.ID {
		t.Fatalf("回收站列表不符: %+v", items)
	}
	if _, err := v.Restore(item.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.Read("n.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), "n.assets")); err != nil {
		t.Fatal("图片目录未恢复")
	}
	if items, _ := v.TrashList(); len(items) != 0 {
		t.Fatal("恢复后回收站应为空")
	}
	if _, err := v.Restore("../../etc"); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("非法回收站 ID 应被拒绝")
	}
}

func TestTreeShowsImagesButHidesMeta(t *testing.T) {
	v := newVault(t)
	v.Write("a.md", []byte("x"), Precondition{})
	link, err := v.SaveAsset("a.md", "i.png", strings.NewReader("i"), 10)
	if err != nil {
		t.Fatal(err)
	}
	v.Mkdir("folder")
	os.WriteFile(filepath.Join(v.Root(), "note.txt"), []byte("x"), 0o644)
	entries, err := v.Tree()
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, e := range entries {
		paths = append(paths, e.Path)
	}
	if strings.Join(paths, ",") != "a.md,assets,"+strings.TrimPrefix(link, "./")+",folder" {
		t.Fatalf("目录树不符: %v", paths)
	}
}
