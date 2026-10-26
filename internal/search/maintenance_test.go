package search

import (
	"context"
	"testing"
)

func TestRebuildRepairsUnchangedRevisionAndOptimizePreservesSearch(t *testing.T) {
	f := newFixture(t)
	f.write("a.md", "# 中文检索\n![](assets/a.png)")
	f.sync()
	if _, err := f.idx.db.Exec(`UPDATE docs SET metadata='{}'`); err != nil {
		t.Fatal(err)
	}
	if err := f.idx.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	notes, ready, err := f.idx.Metadata()
	if err != nil || !ready || len(notes) != 1 || len(notes[0].Assets) != 1 {
		t.Fatalf("重建未重新解析: %+v %v", notes, err)
	}
	if err = f.idx.Optimize(context.Background()); err != nil {
		t.Fatal(err)
	}
	results, err := f.idx.Search("中文", 20)
	if err != nil || len(results) != 1 {
		t.Fatalf("优化影响搜索: %+v %v", results, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = f.idx.Rebuild(ctx); err == nil {
		t.Fatal("取消必须报告失败")
	}
	results, err = f.idx.Search("中文", 20)
	if err != nil || len(results) != 1 {
		t.Fatal("失败重建破坏原索引")
	}
}

func TestRebuildSupersedesQueuedOldSnapshot(t *testing.T) {
	f := newFixture(t)
	f.write("old.md", "old")
	f.sync()
	f.idx.Update(map[string]string{}) // An unconsumed old scan must not delete the new index after a manual rebuild.
	f.write("new.md", "中文新笔记")
	if err := f.idx.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := f.idx.syncPending(); err != nil {
		t.Fatal(err)
	}
	results, err := f.idx.Search("中文", 20)
	if err != nil || len(results) != 1 {
		t.Fatalf("旧快照覆盖重建: %+v %v", results, err)
	}
}
