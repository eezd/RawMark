package vault

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"rawmark/internal/testutil"
	"runtime"
	"sync"
	"testing"
	"time"
)

func TestTrashPurgeFailurePreservesMetadata(t *testing.T) {
	for _, operation := range []string{"single", "all", "expired"} {
		for _, blocked := range []string{"payload", "parent"} {
			t.Run(operation+"/"+blocked, func(t *testing.T) {
				v := newVault(t)
				if _, err := v.Write("folder/locked/note.md", []byte("content"), Precondition{}); err != nil {
					t.Fatal(err)
				}
				setIcon(t, v, "folder", &TreeIcon{Kind: "emoji", Value: "📚"})
				item, err := v.Delete("folder")
				if err != nil {
					t.Fatal(err)
				}
				metaPath := filepath.Join(v.trash, item.ID, "meta.json")
				data, err := os.ReadFile(metaPath)
				if err != nil {
					t.Fatal(err)
				}
				var metadata trashMetadata
				if err := json.Unmarshal(data, &metadata); err != nil {
					t.Fatal(err)
				}
				metadata.DeletedAt = time.Now().Add(-40 * 24 * time.Hour).UnixMilli()
				data, err = json.Marshal(metadata)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(metaPath, data, 0600); err != nil {
					t.Fatal(err)
				}
				locked := filepath.Join(v.trash, item.ID, "folder", "locked")
				if blocked == "parent" {
					locked = v.trash
					if runtime.GOOS == "windows" {
						locked = filepath.Join(v.trash, item.ID)
					}
				}
				allowRemove := testutil.DenyRemove(t, locked)
				purge := func() error {
					if operation == "single" {
						return v.Purge(item.ID)
					}
					days := int64(0)
					if operation == "expired" {
						days = 30
					}
					result, err := v.PurgeTrash(days, time.Now())
					if err == nil && len(result.Failed) > 0 {
						if len(result.Deleted) != 0 || len(result.Failed) != 1 || result.Failed[0].ID != item.ID {
							t.Fatalf("部分失败结果错误: %+v", result)
						}
						return errors.New(result.Failed[0].Error)
					}
					return err
				}
				if err := purge(); err == nil {
					t.Fatal("权限错误应报告失败")
				}
				after, err := os.ReadFile(metaPath)
				if err != nil || !bytes.Equal(data, after) {
					t.Fatalf("删除失败必须保留完整元数据: %v", err)
				}
				items, err := v.TrashList()
				if err != nil || len(items) != 1 || items[0].ID != item.ID {
					t.Fatalf("删除失败的条目必须仍可列出: %+v %v", items, err)
				}
				allowRemove()
				if err := purge(); err != nil {
					t.Fatalf("修复权限后应可继续清理: %v", err)
				}
				if _, err := os.Stat(filepath.Dir(metaPath)); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("成功清理后不应残留目录: %v", err)
				}
			})
		}
	}
}

func trashAt(t *testing.T, v *Vault, path string, when time.Time) TrashItem {
	t.Helper()
	if _, err := v.Write(path, []byte("content"), Precondition{}); err != nil {
		t.Fatal(err)
	}
	item, err := v.Delete(path)
	if err != nil {
		t.Fatal(err)
	}
	meta, err := v.readTrashMetadata(item.ID)
	if err != nil {
		t.Fatal(err)
	}
	meta.DeletedAt = when.UnixMilli()
	data, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(v.trash, item.ID, "meta.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	return meta.TrashItem
}

func TestTrashRetentionAndInvalidMetadata(t *testing.T) {
	v := newVault(t)
	now := time.Now()
	old := trashAt(t, v, "old.md", now.Add(-31*24*time.Hour))
	boundary := trashAt(t, v, "boundary.md", now.Add(-30*24*time.Hour))
	fresh := trashAt(t, v, "fresh.md", now.Add(-29*24*time.Hour))
	future := trashAt(t, v, "future.md", now.Add(time.Hour))
	broken := trashAt(t, v, "broken.md", now.Add(-40*24*time.Hour))
	if err := os.WriteFile(filepath.Join(v.trash, broken.ID, "meta.json"), []byte(`{"deletedAt":0}`), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := v.PurgeTrash(30, now)
	if err != nil || len(result.Deleted) != 2 || len(result.Failed) != 1 || result.Failed[0].ID != broken.ID {
		t.Fatalf("结果异常: %+v, %v", result, err)
	}
	for _, item := range []TrashItem{old, boundary} {
		if _, err := os.Stat(filepath.Join(v.trash, item.ID)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("过期条目未删除: %v", err)
		}
	}
	for _, item := range []TrashItem{fresh, future, broken} {
		if _, err := os.Stat(filepath.Join(v.trash, item.ID)); err != nil {
			t.Fatalf("不应删除未过期/无效条目: %v", err)
		}
	}
	// Very large day counts must not overflow into an expired retention period.
	result, err = v.PurgeTrash(1<<53-1, now)
	if err != nil || len(result.Deleted) != 0 || len(result.Failed) != 1 {
		t.Fatalf("极大期限: %+v, %v", result, err)
	}
	result, err = v.PurgeTrash(0, now)
	if err != nil || len(result.Deleted) != 2 || len(result.Failed) != 1 {
		t.Fatalf("清空全部应独立报告损坏条目: %+v, %v", result, err)
	}
}

func TestTrashRestoreAndPurgeSerialize(t *testing.T) {
	for range 20 {
		v := newVault(t)
		item := trashAt(t, v, "note.md", time.Now().Add(-40*24*time.Hour))
		var restoreErr, purgeErr error
		var result TrashPurgeResult
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); _, restoreErr = v.Restore(item.ID) }()
		go func() { defer wg.Done(); result, purgeErr = v.PurgeTrash(30, time.Now()) }()
		wg.Wait()
		if purgeErr != nil || len(result.Failed) != 0 {
			t.Fatalf("并发清理失败: %+v %v", result, purgeErr)
		}
		if restoreErr == nil {
			if len(result.Deleted) != 0 {
				t.Fatal("已恢复的内容不可再次清理")
			}
			if body, err := os.ReadFile(filepath.Join(v.Root(), item.Path)); err != nil || string(body) != "content" {
				t.Fatalf("恢复内容丢失: %v", err)
			}
		} else if !errors.Is(restoreErr, ErrNotFound) || len(result.Deleted) != 1 {
			t.Fatalf("清理先完成时应明确不存在: %v %+v", restoreErr, result)
		}
	}
}
