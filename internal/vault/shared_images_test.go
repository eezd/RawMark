package vault

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNoteUploadsShareFolderAssetsAndRejectInvalidNotes(t *testing.T) {
	v := newVault(t)
	a, err := v.SaveAsset("dir/a.md", "x.png", strings.NewReader("image"), 100)
	if err != nil {
		t.Fatal(err)
	}
	b, err := v.SaveAsset("dir/b.md", "x.png", strings.NewReader("image"), 100)
	if err != nil || a != b || !strings.HasPrefix(a, "./assets/") {
		t.Fatalf("同目录上传应共享资源：%s %s %v", a, b, err)
	}
	for _, note := range []string{"../x.md", "folder/../x.md", "/x.md", ".hidden/x.md", "a.txt"} {
		if _, err := v.SaveAsset(note, "x.png", strings.NewReader("image"), 100); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("非法笔记路径 %s：%v", note, err)
		}
	}
}

func TestNoteMoveWithoutSharedImagesIgnoresUnrelatedInvalidMetadata(t *testing.T) {
	for _, body := range []string{"# Plain note\n\nNo images or links.", "[attachment](./document.pdf)", "![](plain.assets/old.png)"} {
		t.Run(body, func(t *testing.T) {
			v := newVault(t)
			if _, err := v.Write("unrelated.md", []byte("---\ntags: [broken\n---\n# Unrelated"), Precondition{}); err != nil {
				t.Fatal(err)
			}
			if _, err := v.Write("old/plain.md", []byte(body), Precondition{}); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(body, "plain.assets") {
				if err := v.Mkdir("old/plain.assets"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(v.Root(), "old/plain.assets/old.png"), []byte("legacy"), 0644); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := v.Move("old/plain.md", "new/plain.md"); err != nil {
				t.Fatal("无共享图片的移动不应被无关元数据阻断", err)
			}
			got, _, err := v.Read("new/plain.md")
			expected := strings.ReplaceAll(body, "./document.pdf", "../old/document.pdf")
			if err != nil || string(got) != expected {
				t.Fatalf("移动后的正文不符：%q %v", got, err)
			}
			if _, err := v.Stat("old/plain.md"); !errors.Is(err, ErrNotFound) {
				t.Fatal("源笔记未移走", err)
			}
			if strings.Contains(body, "plain.assets") {
				image, err := os.ReadFile(filepath.Join(v.Root(), "new/plain.assets/old.png"))
				if err != nil || string(image) != "legacy" {
					t.Fatalf("独立附件未随笔记移动：%q %v", image, err)
				}
			}
		})
	}
}

func TestNoteImageMoveStillRejectsUncertainReferences(t *testing.T) {
	v := newVault(t)
	link, err := v.SaveAsset("old/plain.md", "p.png", strings.NewReader("image"), 100)
	if err != nil {
		t.Fatal(err)
	}
	body := "![](" + link + ")"
	for note, content := range map[string]string{"old/plain.md": body, "unrelated.md": "---\ntags: [broken\n---\n# Unrelated"} {
		if _, err := v.Write(note, []byte(content), Precondition{}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := v.Move("old/plain.md", "new/plain.md"); !errors.Is(err, ErrInvalidPath) {
		t.Fatal("无法确认其他笔记引用时不得移除共享图片", err)
	}
	got, _, err := v.Read("old/plain.md")
	if err != nil || string(got) != body {
		t.Fatalf("失败后原文被改写：%q %v", got, err)
	}
	image, err := os.ReadFile(filepath.Join(v.Root(), "old", link))
	if err != nil || string(image) != "image" {
		t.Fatalf("失败后源图丢失：%q %v", image, err)
	}
	if _, err := v.Stat("new/plain.md"); !errors.Is(err, ErrNotFound) {
		t.Fatal("失败后出现目标笔记", err)
	}
}

func TestNoteMoveTransfersSharedImagesWithoutBreakingOtherNotes(t *testing.T) {
	for _, shared := range []bool{false, true} {
		for _, collision := range []string{"none", "same", "different"} {
			t.Run(collision+map[bool]string{false: "-exclusive", true: "-shared"}[shared], func(t *testing.T) {
				v := newVault(t)
				link, err := v.SaveAsset("old/a.md", "a.png", strings.NewReader("image"), 100)
				if err != nil {
					t.Fatal(err)
				}
				file := filepath.Base(link)
				body := "![图](" + link + "?q=1#part \"标题\")\n[图]: " + link + "\n<img src=\"" + link + "\">\n`![](" + link + ")`\n\n$$\n![](" + link + ")\n$$\n"
				if _, err := v.Write("old/a.md", []byte(body), Precondition{}); err != nil {
					t.Fatal(err)
				}
				if shared {
					if _, err := v.Write("else/b.md", []byte("[图片](../old/assets/"+file+")"), Precondition{}); err != nil {
						t.Fatal(err)
					}
				}
				if collision != "none" {
					if err := v.Mkdir("new/assets"); err != nil {
						t.Fatal(err)
					}
					data := "image"
					if collision == "different" {
						data = "unrelated"
					}
					if err := os.WriteFile(filepath.Join(v.Root(), "new/assets", file), []byte(data), 0644); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := v.Move("old/a.md", "new/renamed.md"); err != nil {
					t.Fatal(err)
				}
				got, _, err := v.Read("new/renamed.md")
				if err != nil {
					t.Fatal(err)
				}
				metadata := Analyze("new/renamed.md", got)
				for _, ref := range metadata.Assets {
					if filepath.ToSlash(filepath.Dir(ref.Target)) != "new/assets" {
						t.Fatalf("图片未归入目标目录：%s", got)
					}
					data, err := os.ReadFile(filepath.Join(v.Root(), ref.Target))
					if err != nil || string(data) != "image" {
						t.Fatalf("图片丢失或被覆盖：%q %v", data, err)
					}
				}
				if !strings.Contains(string(got), "?q=1#part \"标题\"") || !strings.Contains(string(got), "`![]("+link+")`") || !strings.Contains(string(got), "$$\n![]("+link+")") {
					t.Fatalf("正文中的标题、代码或公式被改写：%s", got)
				}
				_, err = os.Stat(filepath.Join(v.Root(), "old/assets", file))
				if (shared && err != nil) || (!shared && !os.IsNotExist(err)) {
					t.Fatalf("源图保留状态错误 shared=%v：%v", shared, err)
				}
				if collision == "different" {
					data, _ := os.ReadFile(filepath.Join(v.Root(), "new/assets", file))
					if string(data) != "unrelated" {
						t.Fatal("目标已有图片被覆盖")
					}
				}
			})
		}
	}
}

func TestNoteDeleteAndRenamePreserveSharedAssets(t *testing.T) {
	v := newVault(t)
	link, err := v.SaveAsset("a.md", "a.png", strings.NewReader("image"), 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, note := range []string{"a.md", "b.md"} {
		if _, err := v.Write(note, []byte("![]("+link+")"), Precondition{}); err != nil {
			t.Fatal(err)
		}
	}
	if rewritten, err := v.Move("a.md", "renamed.md"); err != nil || rewritten {
		t.Fatalf("同目录改名无需改写图片：%v %v", rewritten, err)
	}
	item, err := v.Delete("renamed.md")
	if err != nil || item.Assets != "" {
		t.Fatalf("删除笔记不得带走共享目录：%+v %v", item, err)
	}
	if _, err := v.Stat(strings.TrimPrefix(link, "./")); err != nil {
		t.Fatal("共享图片丢失", err)
	}
	if _, err := v.Restore(item.ID); err != nil {
		t.Fatal(err)
	}
}

func TestFailedNoteImageTransferRemovesOnlyCreatedCopies(t *testing.T) {
	v := newVault(t)
	if err := v.Mkdir("old/assets"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"first.png", "second.png"} {
		if err := os.WriteFile(filepath.Join(v.Root(), "old/assets", name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	body := "![](assets/first.png) ![](assets/second.png)"
	if _, err := v.Write("old/a.md", []byte(body), Precondition{}); err != nil {
		t.Fatal(err)
	}
	if err := v.Mkdir("new/assets"); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(v.Root(), "new/assets/second.png")); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Move("old/a.md", "new/a.md"); err == nil {
		t.Fatal("越界链接应使移动失败")
	}
	got, _, err := v.Read("old/a.md")
	if err != nil || string(got) != body {
		t.Fatalf("失败后原文丢失：%s %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), "new/assets/first.png")); !os.IsNotExist(err) {
		t.Fatal("已创建副本没有撤回", err)
	}
	for _, name := range []string{"first.png", "second.png"} {
		if _, err := v.Stat("old/assets/" + name); err != nil {
			t.Fatal("源图不应被移除", err)
		}
	}
}

func TestImportSharesImagesAndRemovesOnlyMigratedOriginals(t *testing.T) {
	v := newVault(t)
	source := importZip(t,
		zipEntry{name: "a.md", content: "![](original/p.png)"},
		zipEntry{name: "b.md", content: "[图片](original/p.png)"},
		zipEntry{name: "sub/c.md", content: "<img src=\"../original/p.png\">"},
		zipEntry{name: "original/p.png", content: "shared"},
		zipEntry{name: "original/unused.png", content: "unused"},
		zipEntry{name: "original/document.pdf", content: "attachment"},
	)
	result, err := v.Import(context.Background(), "", "imported", []ImportFile{source})
	if err != nil || result.Assets != 4 {
		t.Fatalf("共享图片与其他附件数量不符：%+v %v", result, err)
	}
	if _, err := v.Stat("imported/original/p.png"); !errors.Is(err, ErrNotFound) {
		t.Fatal("重复原图未清理", err)
	}
	for _, original := range []string{"unused.png", "document.pdf"} {
		if _, err := v.Stat("imported/original/" + original); err != nil {
			t.Fatal("不应清理其他原始附件", err)
		}
	}
	for _, note := range []string{"a.md", "b.md", "sub/c.md"} {
		body, _, err := v.Read("imported/" + note)
		if err != nil {
			t.Fatal(err)
		}
		refs := Analyze("imported/"+note, body).Assets
		if len(refs) != 1 || !strings.HasPrefix(string(body), map[string]string{"a.md": "![](./assets/", "b.md": "[图片](./assets/", "sub/c.md": "<img src=\"./assets/"}[note]) {
			t.Fatalf("导入链接不符：%s", body)
		}
		if _, err := v.Stat(refs[0].Target); err != nil {
			t.Fatal("导入引用缺失", err)
		}
	}
}
