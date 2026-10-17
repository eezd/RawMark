package vault

import (
	"errors"
	"os"
	"path/filepath"
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
	link, err := v.SaveAsset("dir/笔记 A.md", "x.png", strings.NewReader("png"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(link, "笔记%20A.assets/") {
		t.Fatalf("资源链接不符: %s", link)
	}
	if err := v.Move("dir/笔记 A.md", "other/B.md"); err != nil {
		t.Fatal(err)
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
	if err := v.Move("other", "other/sub"); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("文件夹移入自身应被拒绝")
	}
}

func TestDeleteRestore(t *testing.T) {
	v := newVault(t)
	v.Write("n.md", []byte("x"), Precondition{})
	v.SaveAsset("n.md", "a.png", strings.NewReader("img"), 100)
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

func TestTreeHidesMetaAndAssets(t *testing.T) {
	v := newVault(t)
	v.Write("a.md", []byte("x"), Precondition{})
	v.SaveAsset("a.md", "i.png", strings.NewReader("i"), 10)
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
	if strings.Join(paths, ",") != "a.md,folder" {
		t.Fatalf("目录树不符: %v", paths)
	}
}

func TestEncryptedNotes(t *testing.T) {
	v := newVault(t)
	if _, err := v.Write("a.md", []byte("明文"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	link, err := v.SaveAsset("a.md", "x.png", strings.NewReader("png"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	// 同名的普通笔记与加密笔记不能同时存在（二者共用 a.assets）
	if _, err := v.Write("a.md.enc", []byte("{}"), Precondition{}); !errors.Is(err, ErrExists) {
		t.Fatal("同名加密笔记不应能直接创建:", err)
	}
	// 转换校验原笔记版本，写入新笔记并永久删除原笔记
	if _, err := v.Convert("a.md", "a.md.enc", []byte(`{"v":1}`), Precondition{IfMatch: "stale"}); !isConflict(err) {
		t.Fatal("版本不符时应拒绝转换:", err)
	}
	if _, err := v.Convert("a.md", "b.md.enc", []byte(`{}`), Precondition{}); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("只能转换为同名笔记:", err)
	}
	if _, err := v.Convert("a.md", "a.md.enc", []byte(`{"v":1}`), Precondition{IfMatch: Rev([]byte("明文"))}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.Read("a.md"); !errors.Is(err, ErrNotFound) {
		t.Fatal("原笔记应被删除")
	}
	if items, _ := v.TrashList(); len(items) != 0 {
		t.Fatal("转换前的明文不应进入回收站")
	}
	// 加密笔记的图片统一为 .enc，与普通笔记共用图片目录
	encLink, err := v.SaveAsset("a.md.enc", "y.png", strings.NewReader("密文"), 1<<20)
	if err != nil || !strings.HasPrefix(encLink, "a.assets/") || !strings.HasSuffix(encLink, ".enc") {
		t.Fatal("加密图片链接不符:", encLink, err)
	}
	// 清理转换前的明文图片：只允许删除 .assets 目录中的文件
	if err := v.DeleteAsset(link); err != nil {
		t.Fatal(err)
	}
	if err := v.DeleteAsset("a.md.enc"); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("不应能经此删除笔记")
	}
	// 改名：图片目录随之移动，密文不改写；不能借移动转换类型，也不能与同名普通笔记冲突
	if err := v.Move("a.md.enc", "c.md"); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("移动不能改变加密类型:", err)
	}
	if _, err := v.Write("c.md", []byte("x"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	if err := v.Move("a.md.enc", "c.md.enc"); !errors.Is(err, ErrExists) {
		t.Fatal("不能移动到与普通笔记同名:", err)
	}
	if err := v.Move("a.md.enc", "d.md.enc"); err != nil {
		t.Fatal(err)
	}
	if data, _, _ := v.Read("d.md.enc"); string(data) != `{"v":1}` {
		t.Fatal("加密笔记内容不应被改写:", string(data))
	}
	if _, err := os.Stat(filepath.Join(v.Root(), strings.Replace(encLink, "a.assets", "d.assets", 1))); err != nil {
		t.Fatal("图片目录未随加密笔记移动:", err)
	}
	entries, _ := v.Tree()
	var names []string
	for _, e := range entries {
		names = append(names, e.Path)
	}
	if strings.Join(names, ",") != "c.md,d.md.enc" {
		t.Fatal("目录树应包含加密笔记:", names)
	}
}

func TestKeyring(t *testing.T) {
	v := newVault(t)
	if _, _, err := v.ReadKeyring(); !errors.Is(err, ErrNotFound) {
		t.Fatal("尚未设置时应返回 ErrNotFound")
	}
	if _, err := v.WriteKeyring([]byte("not json"), Precondition{IfNoneMatch: true}); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("应拒绝非 JSON")
	}
	rev, err := v.WriteKeyring([]byte(`{"v":1}`), Precondition{IfNoneMatch: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.WriteKeyring([]byte(`{"v":2}`), Precondition{IfNoneMatch: true}); !errors.Is(err, ErrExists) {
		t.Fatal("已设置时不能再次初始化")
	}
	if _, err := v.WriteKeyring([]byte(`{"v":2}`), Precondition{IfMatch: "stale"}); !isConflict(err) {
		t.Fatal("版本不符时应拒绝")
	}
	if _, err := v.WriteKeyring([]byte(`{"v":2}`), Precondition{IfMatch: rev}); err != nil {
		t.Fatal(err)
	}
	if data, _, _ := v.ReadKeyring(); string(data) != `{"v":2}` {
		t.Fatal("密钥环内容不符:", string(data))
	}
	// 密钥环在隐藏目录中，不经文件接口暴露
	if _, _, err := v.Read(".rawmark/keyring.json"); err == nil {
		t.Fatal("不应能经文件接口读取密钥环")
	}
}

func isConflict(err error) bool {
	var c *ConflictError
	return errors.As(err, &c)
}
