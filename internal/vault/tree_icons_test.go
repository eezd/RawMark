package vault

import (
	"errors"
	"os"
	"path/filepath"
	"rawmark/internal/testutil"
	"reflect"
	"strings"
	"testing"
)

func setIcon(t *testing.T, v *Vault, path string, icon *TreeIcon) {
	t.Helper()
	if err := v.SetTreeIcon(path, icon); err != nil {
		t.Fatal(err)
	}
}

func treeIcons(t *testing.T, v *Vault) map[string]TreeIcon {
	t.Helper()
	entries, err := v.Tree()
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]TreeIcon{}
	for _, entry := range entries {
		if entry.Icon != nil {
			result[entry.Path] = *entry.Icon
		}
	}
	return result
}

func TestTreeIconsPersistFollowSubtreeAndTrash(t *testing.T) {
	v := newVault(t)
	if _, err := os.Stat(filepath.Join(v.root, metaDir, "tree-icons.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("未修改时不应生成图标文件", err)
	}
	if _, err := v.Write("folder/nested/note.md", []byte("# 正文\n"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	folder, note := TreeIcon{"emoji", "📚"}, TreeIcon{"builtin", "task"}
	setIcon(t, v, "folder", &folder)
	setIcon(t, v, "folder/nested/note.md", &note)
	body, rev, err := v.Read("folder/nested/note.md")
	if err != nil || string(body) != "# 正文\n" || rev != Rev([]byte("# 正文\n")) {
		t.Fatal("图标修改了正文/版本", err)
	}
	v, err = Open(v.root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Move("folder/nested/note.md", "folder/nested/renamed.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Move("folder", "destination/moved"); err != nil {
		t.Fatal(err)
	}
	want := map[string]TreeIcon{"destination/moved": folder, "destination/moved/nested/renamed.md": note}
	if got := treeIcons(t, v); !reflect.DeepEqual(got, want) {
		t.Fatalf("改名/移动后图标不符: %v", got)
	}
	item, err := v.Delete("destination/moved")
	if err != nil {
		t.Fatal(err)
	}
	if got := treeIcons(t, v); len(got) != 0 {
		t.Fatalf("删除后保留了属性: %v", got)
	}
	if _, err := v.Write("destination/moved/nested/renamed.md", []byte("新内容"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	if got := treeIcons(t, v); len(got) != 0 {
		t.Fatalf("同名新文件继承了属性: %v", got)
	}
	if _, err := v.Restore(item.ID); !errors.Is(err, ErrExists) {
		t.Fatal("恢复冲突应失败", err)
	}
	if _, err := v.Move("destination/moved", "replacement"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Restore(item.ID); err != nil {
		t.Fatal(err)
	}
	if got := treeIcons(t, v); !reflect.DeepEqual(got, want) {
		t.Fatalf("恢复后图标不符: %v", got)
	}
	setIcon(t, v, "destination/moved", nil)
	delete(want, "destination/moved")
	if got := treeIcons(t, v); !reflect.DeepEqual(got, want) {
		t.Fatalf("恢复默认失败: %v", got)
	}
	// Legacy recycle-bin entries without icons remain restorable.
	item, err = v.Delete("replacement")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Restore(item.ID); err != nil {
		t.Fatal(err)
	}
}

func TestTreeIconValidationAndCorruptMetadata(t *testing.T) {
	v := newVault(t)
	if _, err := v.Write("a.md", []byte("body"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"📂", "👨‍👩‍👧‍👦", "👩🏽‍💻", "🇨🇳", "1️⃣", "©️", "ℹ️", "↔️", "◼️", "‼️", "〰️", "🏴\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f"} {
		setIcon(t, v, "a.md", &TreeIcon{"emoji", value})
	}
	for _, icon := range []TreeIcon{{"url", "https://example.com"}, {"builtin", "__proto__"}, {"builtin", "folder note"}, {"emoji", ""}, {"emoji", "hello"}, {"emoji", "<svg>"}, {"emoji", "\u200d"}, {"emoji", strings.Repeat("📂", 17)}} {
		if err := v.SetTreeIcon("a.md", &icon); !errors.Is(err, ErrInvalidIcon) {
			t.Fatalf("应拒绝 %+v: %v", icon, err)
		}
	}
	if err := v.SetTreeIcon("../a.md", nil); !errors.Is(err, ErrInvalidPath) {
		t.Fatal(err)
	}
	if err := v.SetTreeIcon("missing.md", nil); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(v.root, "a.md"), filepath.Join(v.root, "link.md")); err != nil {
		t.Fatal(err)
	}
	if err := v.SetTreeIcon("link.md", nil); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("不应设置符号链接图标", err)
	}
	for _, data := range []string{"{", "null", `{"../a.md":{"kind":"emoji","value":"📂"}}`, `{"a.md":{"kind":"builtin","value":"absent"}}`} {
		if err := os.WriteFile(filepath.Join(v.root, metaDir, "tree-icons.json"), []byte(data), 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := v.Tree(); err == nil {
			t.Fatal("损坏元数据不应静默清空")
		}
		if _, err := v.Move("a.md", "b.md"); err == nil {
			t.Fatal("元数据异常时应停止移动")
		}
		if _, err := v.Delete("a.md"); err == nil {
			t.Fatal("元数据异常时应停止删除")
		}
		if _, _, err := v.Read("a.md"); err != nil {
			t.Fatal("原件应保持可用", err)
		}
	}
}

func TestTreeIconWriteFailureRollsBack(t *testing.T) {
	for _, operation := range []string{"set", "move", "delete", "restore"} {
		t.Run(operation, func(t *testing.T) {
			v := newVault(t)
			if _, err := v.Write("a.md", []byte("[link](other.md)"), Precondition{}); err != nil {
				t.Fatal(err)
			}
			legacyAsset(t, v, "a.md", "p.png", "image")
			icon := TreeIcon{"emoji", "📚"}
			setIcon(t, v, "a.md", &icon)
			var item TrashItem
			var err error
			if operation == "restore" {
				item, err = v.Delete("a.md")
				if err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.ReadFile(filepath.Join(v.root, metaDir, "tree-icons.json"))
			if err != nil {
				t.Fatal(err)
			}
			testutil.DenyReplace(t, filepath.Join(v.root, metaDir, "tree-icons.json"))
			switch operation {
			case "set":
				err = v.SetTreeIcon("a.md", &TreeIcon{"builtin", "folder"})
			case "move":
				_, err = v.Move("a.md", "new/b.md")
			case "delete":
				_, err = v.Delete("a.md")
			case "restore":
				_, err = v.Restore(item.ID)
			}
			if err == nil {
				t.Fatal("图标元数据写失败却返回成功")
			}
			after, err := os.ReadFile(filepath.Join(v.root, metaDir, "tree-icons.json"))
			if err != nil || string(before) != string(after) {
				t.Fatal("原有元数据被改变", err)
			}
			if operation == "restore" {
				if _, err := v.Stat("a.md"); !errors.Is(err, ErrNotFound) {
					t.Fatal("恢复应撤回", err)
				}
				metadata, err := v.readTrashMetadata(item.ID)
				if err != nil || metadata.Icons["a.md"] != icon {
					t.Fatal("回收站图标丢失", err)
				}
			} else {
				body, _, err := v.Read("a.md")
				if err != nil || string(body) != "[link](other.md)" {
					t.Fatal("原件或正文未回滚", err)
				}
				if _, err := os.Stat(filepath.Join(v.root, "a.assets")); err != nil {
					t.Fatal("附件未回滚", err)
				}
				if _, err := v.Stat("new/b.md"); !errors.Is(err, ErrNotFound) {
					t.Fatal("移动目标未撤回", err)
				}
			}
		})
	}
}
