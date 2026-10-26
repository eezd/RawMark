// Package watch monitors vault changes, including RawMark writes and external editor/sync-tool changes,
// and broadcasts differences from the previous snapshot. All changes flow through the filesystem; clients recognize their own writes by rev.
package watch

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"rawmark/internal/i18n"
	"sort"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"

	"rawmark/internal/events"
	"rawmark/internal/vault"
)

const (
	debounce = 100 * time.Millisecond
	// inotify is unreliable on Docker Desktop bind mounts, NFS, and similar setups; periodically perform a full scan.
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

// Start begins watching. onScan receives all note paths -> rev after the first scan and each changed scan, for search indexing.
// Return a shutdown notification; instance recovery must wait for watching to stop before replacing the vault.
func Start(ctx context.Context, v *vault.Vault, hub *events.Hub, onScan func(notes map[string]string)) (<-chan struct{}, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &Watcher{v: v, hub: hub, fw: fw, snap: map[string]fileState{}, watched: map[string]bool{}, onScan: onScan}
	snap, err := w.scan()
	if err != nil {
		fw.Close()
		return nil, err
	}
	w.snap = snap
	w.onScan(notes(snap))
	done := make(chan struct{})
	go func() { defer close(done); w.loop(ctx) }()
	return done, nil
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
			// Queue overflows can lose events; immediately rescan to recover them.
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

// scan reads the current tree and recalculates revisions only for new files or changes in size/modification time.
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
					continue // Deleted during scanning; the next pass will handle it.
				}
				if err != nil {
					return nil, i18n.New("could_not_read_note_s_708ab5", e.Path, err)
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
			delete(w.watched, d) // The directory was deleted; inotify removes its watch automatically.
		}
	}
	return next, nil
}

// diff identifies moves by filesystem identity; identical contents do not imply the same file.
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
	candidates := map[string]string{} // New path -> unique original path.
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
		case !cur.dir && cur.rev == "" && (old.size != cur.size || old.mtime != cur.mtime || !os.SameFile(old.info, cur.info)):
			// Images lack text revisions; replacements must still refresh list metadata and previews.
			if vault.IsImage(p) {
				structural = true
			}
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
		// Apply parent-directory mappings first; independently renamed children then move from their mapped paths.
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
