package watch

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/fsnotify/fsnotify"

	"rawmark/internal/events"
	"rawmark/internal/vault"
)

func TestUnreadableNotePreservesSnapshot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("权限回归需要以非 root 用户运行")
	}
	v, err := vault.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(v.Root(), "note.md")
	if err := os.WriteFile(p, []byte("原文"), 0o644); err != nil {
		t.Fatal(err)
	}
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	defer fw.Close()
	scans := 0
	hub := events.NewHub()
	w := &Watcher{v: v, fw: fw, hub: hub, snap: map[string]fileState{}, watched: map[string]bool{}, onScan: func(map[string]string) { scans++ }}
	w.snap, err = w.scan()
	if err != nil {
		t.Fatal(err)
	}
	old := w.snap["note.md"].rev
	ch, cancel := hub.Subscribe()
	defer cancel()
	if err := os.WriteFile(p, []byte("修改后的较长正文"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, 0); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(p, 0o644)
	w.rescan()
	if w.snap["note.md"].rev != old || scans != 0 {
		t.Fatal("读取失败不能提交不完整快照或更新索引")
	}
	select {
	case msg := <-ch:
		t.Fatalf("读取失败不能广播删除事件: %s", msg)
	default:
	}
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatal(err)
	}
	w.rescan()
	if w.snap["note.md"].rev == old || scans != 1 {
		t.Fatal("恢复读取权限后应同步新版本")
	}
}

func TestDiff(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"d/a.md", "b.md", "c.md", "c2.md"} {
		if err := os.WriteFile(filepath.Join(root, p), []byte("相同内容"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	state := func(p, rev string) fileState {
		info, err := os.Stat(filepath.Join(root, p))
		if err != nil {
			t.Fatal(err)
		}
		return fileState{dir: info.IsDir(), rev: rev, info: info}
	}
	prev := map[string]fileState{
		"d":      state("d", ""),
		"d/a.md": state("d/a.md", "r1"),
		"b.md":   state("b.md", "r2"),
		"c.md":   state("c.md", "same"),
		"c2.md":  state("c2.md", "same"),
	}
	for from, to := range map[string]string{"d/a.md": "d/x.md", "c2.md": "e.md"} {
		if err := os.Rename(filepath.Join(root, from), filepath.Join(root, to)); err != nil {
			t.Fatal(err)
		}
	}
	next := map[string]fileState{
		"d":      state("d", ""),
		"d/x.md": state("d/x.md", "r1"),
		"b.md":   state("b.md", "r3"),
		"e.md":   state("e.md", "same"),
	}
	var got []string
	for _, e := range diff(prev, next) {
		f := []string{e.Type}
		if e.From != "" {
			f = append(f, e.From)
		}
		if e.Path != "" {
			f = append(f, e.Path)
		}
		got = append(got, strings.Join(f, " "))
	}
	sort.Strings(got)
	want := "changed b.md|deleted c.md|moved c2.md e.md|moved d/a.md d/x.md|tree"
	if strings.Join(got, "|") != want {
		t.Fatalf("事件不符:\n got %q\nwant %q", strings.Join(got, "|"), want)
	}
	if evs := diff(next, next); len(evs) != 0 {
		t.Fatalf("快照相同不应产生事件: %v", evs)
	}
}

func TestDirectoryMovesCoverChildrenAndEmptyDirectories(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "from", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "from", "a.md"), []byte("正文"), 0o644); err != nil {
		t.Fatal(err)
	}
	snapshot := func(dir string) map[string]fileState {
		out := map[string]fileState{}
		for _, rel := range []string{dir, dir + "/empty", dir + "/a.md"} {
			info, err := os.Stat(filepath.Join(root, rel))
			if err != nil {
				t.Fatal(err)
			}
			out[rel] = fileState{dir: info.IsDir(), info: info, rev: "same"}
		}
		return out
	}
	prev := snapshot("from")
	if err := os.Rename(filepath.Join(root, "from"), filepath.Join(root, "to")); err != nil {
		t.Fatal(err)
	}
	events := diff(prev, snapshot("to"))
	if len(events) != 2 || events[0].Type != "moved" || events[0].From != "from" || events[0].Path != "to" || events[1].Type != "tree" {
		t.Fatalf("目录移动应只产生一次路径映射: %v", events)
	}
	next := snapshot("to")
	if err := os.Rename(filepath.Join(root, "to", "a.md"), filepath.Join(root, "to", "b.md")); err != nil {
		t.Fatal(err)
	}
	next["to/b.md"] = next["to/a.md"]
	delete(next, "to/a.md")
	events = diff(prev, next)
	if len(events) != 3 || events[0].From != "from" || events[0].Path != "to" || events[1].From != "to/a.md" || events[1].Path != "to/b.md" || events[2].Type != "tree" {
		t.Fatalf("同一批次内子项改名应接续父目录映射: %v", events)
	}
}

func TestNotesExcludeResourceContents(t *testing.T) {
	indexed := notes(map[string]fileState{
		"笔记.md":           {rev: "r1"},
		"笔记.assets/说明.md": {rev: "r2"},
		"附件.txt":          {},
	})
	if len(indexed) != 1 || indexed["笔记.md"] != "r1" {
		t.Fatalf("跟踪普通文件移动不能改变笔记索引范围: %v", indexed)
	}
}
