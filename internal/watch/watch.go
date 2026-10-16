// Package watch 监听仓库目录的变化（包括 RawMark 自身的写入和外部编辑器/同步工具的修改），
// 与上一次快照比较后把差异作为事件广播。所有变更都经由文件系统这一条路径，客户端据 rev 识别自己的写入。
package watch

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/fsnotify/fsnotify"

	"rawmark/internal/events"
	"rawmark/internal/vault"
)

const (
	debounce = 100 * time.Millisecond
	// inotify 在 Docker Desktop 的绑定挂载、NFS 等环境下不可靠，定期全量扫描兜底
	rescanInterval = 5 * time.Minute
)

type fileState struct {
	dir   bool
	size  int64
	mtime int64
	rev   string
}

type Watcher struct {
	v       *vault.Vault
	hub     *events.Hub
	fw      *fsnotify.Watcher
	snap    map[string]fileState
	watched map[string]bool
}

func Start(ctx context.Context, v *vault.Vault, hub *events.Hub) error {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	w := &Watcher{v: v, hub: hub, fw: fw, snap: map[string]fileState{}, watched: map[string]bool{}}
	snap, err := w.scan()
	if err != nil {
		fw.Close()
		return err
	}
	w.snap = snap
	go w.loop(ctx)
	return nil
}

func (w *Watcher) loop(ctx context.Context) {
	defer w.fw.Close()
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	ticker := time.NewTicker(rescanInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-w.fw.Events:
			if !ok {
				return
			}
			timer.Reset(debounce)
		case err, ok := <-w.fw.Errors:
			if !ok {
				return
			}
			// 事件队列溢出等情况会丢事件，立即全量扫描补齐
			slog.Warn("文件监听出错，执行全量扫描", "err", err)
			timer.Reset(debounce)
		case <-timer.C:
			w.rescan()
		case <-ticker.C:
			w.rescan()
		}
	}
}

func (w *Watcher) rescan() {
	next, err := w.scan()
	if err != nil {
		slog.Error("扫描仓库失败", "err", err)
		return
	}
	evs := diff(w.snap, next)
	w.snap = next
	w.hub.Broadcast(evs...)
}

// scan 读取当前目录树；内容版本只对新出现或大小/修改时间变化的文件重新计算
func (w *Watcher) scan() (map[string]fileState, error) {
	entries, err := w.v.Tree()
	if err != nil {
		return nil, err
	}
	next := make(map[string]fileState, len(entries))
	dirs := map[string]bool{w.v.Root(): true}
	for _, e := range entries {
		st := fileState{dir: e.Dir, size: e.Size, mtime: e.ModTime}
		abs := filepath.Join(w.v.Root(), filepath.FromSlash(e.Path))
		if e.Dir {
			dirs[abs] = true
		} else if old, ok := w.snap[e.Path]; ok && !old.dir && old.size == st.size && old.mtime == st.mtime {
			st.rev = old.rev
		} else {
			data, err := os.ReadFile(abs)
			if err != nil {
				continue // 扫描期间被删除，下一轮会处理
			}
			st.rev = vault.Rev(data)
		}
		next[e.Path] = st
	}
	for d := range dirs {
		if !w.watched[d] {
			if err := w.fw.Add(d); err != nil {
				slog.Warn("添加目录监听失败", "dir", d, "err", err)
				continue
			}
			w.watched[d] = true
		}
	}
	for d := range w.watched {
		if !dirs[d] {
			delete(w.watched, d) // 目录已删除，inotify 会自动移除监听
		}
	}
	return next, nil
}

// diff 比较两次快照：内容相同的"删除 + 新增"视为移动
func diff(prev, next map[string]fileState) []events.Event {
	var evs []events.Event
	structural := false
	removed := map[string][]string{} // rev -> 被删除的路径（内容相同的文件可能有多个）
	for p, old := range prev {
		if _, ok := next[p]; ok {
			continue
		}
		structural = true
		if !old.dir {
			removed[old.rev] = append(removed[old.rev], p)
		}
	}
	for p, cur := range next {
		old, existed := prev[p]
		switch {
		case !existed:
			structural = true
			if froms := removed[cur.rev]; len(froms) > 0 && !cur.dir {
				removed[cur.rev] = froms[1:]
				evs = append(evs, events.Event{Type: "moved", From: froms[0], Path: p, Rev: cur.rev})
			}
		case old.dir != cur.dir:
			structural = true
		case !cur.dir && old.rev != cur.rev:
			evs = append(evs, events.Event{Type: "changed", Path: p, Rev: cur.rev})
		}
	}
	for _, paths := range removed {
		for _, p := range paths {
			evs = append(evs, events.Event{Type: "deleted", Path: p})
		}
	}
	if structural {
		evs = append(evs, events.Event{Type: "tree"})
	}
	return evs
}
