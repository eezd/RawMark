// Package watch 监听仓库目录的变化（包括 RawMark 自身的写入和外部编辑器/同步工具的修改），
// 与上一次快照比较后把差异作为事件广播。所有变更都经由文件系统这一条路径，客户端据 rev 识别自己的写入。
package watch

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
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
	info  os.FileInfo
}

type Watcher struct {
	v       *vault.Vault
	hub     *events.Hub
	fw      *fsnotify.Watcher
	snap    map[string]fileState
	watched map[string]bool
	onScan  func(notes map[string]string)
}

// Start 开始监听。onScan 在首次扫描及之后每次有变化的扫描后调用，参数为全部笔记的路径 -> rev（用于更新搜索索引）
func Start(ctx context.Context, v *vault.Vault, hub *events.Hub, onScan func(notes map[string]string)) error {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	w := &Watcher{v: v, hub: hub, fw: fw, snap: map[string]fileState{}, watched: map[string]bool{}, onScan: onScan}
	snap, err := w.scan()
	if err != nil {
		fw.Close()
		return err
	}
	w.snap = snap
	w.onScan(notes(snap))
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
	if len(evs) > 0 {
		w.onScan(notes(next))
	}
	w.hub.Broadcast(evs...)
}

func notes(snap map[string]fileState) map[string]string {
	out := make(map[string]string, len(snap))
	for p, st := range snap {
		if !st.dir && vault.IsNote(p) {
			visible := true
			for _, segment := range strings.Split(p, "/") {
				if strings.HasSuffix(segment, vault.AssetsExt) {
					visible = false
					break
				}
			}
			if visible {
				out[p] = st.rev
			}
		}
	}
	return out
}

// scan 读取当前目录树；内容版本只对新出现或大小/修改时间变化的文件重新计算
func (w *Watcher) scan() (map[string]fileState, error) {
	entries, err := w.v.TreeAt("")
	if err != nil {
		return nil, err
	}
	next := make(map[string]fileState, len(entries))
	dirs := map[string]bool{w.v.Root(): true}
	for _, e := range entries {
		st := fileState{dir: e.Dir, size: e.Size, mtime: e.Info.ModTime().UnixNano(), info: e.Info}
		abs := filepath.Join(w.v.Root(), filepath.FromSlash(e.Path))
		if e.Dir {
			dirs[abs] = true
		} else if vault.IsNote(e.Path) {
			if old, ok := w.snap[e.Path]; ok && !old.dir && old.size == st.size && old.mtime == st.mtime && os.SameFile(old.info, st.info) {
				st.rev = old.rev
			} else {
				data, err := os.ReadFile(abs)
				if errors.Is(err, fs.ErrNotExist) {
					continue // 扫描期间被删除，下一轮会处理
				}
				if err != nil {
					return nil, fmt.Errorf("读取笔记 %s 失败: %w", e.Path, err)
				}
				st.rev = vault.Rev(data)
			}
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

// diff 按文件系统身份识别移动，内容相同不代表同一个分享主体。
func diff(prev, next map[string]fileState) []events.Event {
	var evs []events.Event
	structural := false
	removed := map[string]fileState{}
	for p, old := range prev {
		if _, ok := next[p]; ok {
			continue
		}
		structural = true
		removed[p] = old
	}
	candidates := map[string]string{} // 新路径 -> 唯一的原路径
	destinations := map[string]int{}
	for p, cur := range next {
		old, existed := prev[p]
		switch {
		case !existed:
			structural = true
			from := ""
			matches := 0
			for oldPath, old := range removed {
				if os.SameFile(old.info, cur.info) {
					from = oldPath
					matches++
				}
			}
			if matches == 1 {
				candidates[p] = from
				destinations[from]++
			}
		case old.dir != cur.dir:
			structural = true
		case !cur.dir && old.rev != cur.rev:
			evs = append(evs, events.Event{Type: "changed", Path: p, Rev: cur.rev})
		}
	}
	var moves []events.Event
	for to, from := range candidates {
		if destinations[from] == 1 {
			delete(removed, from)
			moves = append(moves, events.Event{Type: "moved", From: from, Path: to, Rev: next[to].rev})
		}
	}
	sort.Slice(moves, func(i, j int) bool { return len(moves[i].From) < len(moves[j].From) })
	var emitted []events.Event
	for _, move := range moves {
		for _, parent := range emitted {
			if strings.HasPrefix(move.From, parent.From+"/") {
				move.From = parent.Path + strings.TrimPrefix(move.From, parent.From)
			}
		}
		// 先应用父目录映射；子项另有改名时，从映射后的路径继续移动。
		if move.From != move.Path {
			emitted = append(emitted, move)
		}
	}
	evs = append(emitted, evs...)
	for p := range removed {
		evs = append(evs, events.Event{Type: "deleted", Path: p})
	}
	if structural {
		evs = append(evs, events.Event{Type: "tree"})
	}
	return evs
}
