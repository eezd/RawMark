package watch

import (
	"sort"
	"strings"
	"testing"
)

func TestDiff(t *testing.T) {
	prev := map[string]fileState{
		"d":      {dir: true},
		"d/a.md": {rev: "r1"},
		"b.md":   {rev: "r2"},
		"c.md":   {rev: "same"},
		"c2.md":  {rev: "same"},
	}
	next := map[string]fileState{
		"d":      {dir: true},
		"d/x.md": {rev: "r1"},   // 由 d/a.md 移动而来
		"b.md":   {rev: "r3"},   // 内容修改
		"e.md":   {rev: "same"}, // c.md 与 c2.md 内容相同：其一视为移动到此，另一个为删除
	}
	var got []string
	for _, e := range diff(prev, next) {
		f := []string{e.Type}
		if e.From != "" {
			f = append(f, "c*")
			if !strings.HasPrefix(e.From, "c") {
				f[1] = e.From
			}
		}
		if e.Path != "" {
			f = append(f, e.Path)
			if e.Type == "deleted" && strings.HasPrefix(e.Path, "c") {
				f[1] = "c*"
			}
		}
		got = append(got, strings.Join(f, " "))
	}
	sort.Strings(got)
	want := "changed b.md|deleted c*|moved c* e.md|moved d/a.md d/x.md|tree"
	if strings.Join(got, "|") != want {
		t.Fatalf("事件不符:\n got %q\nwant %q", strings.Join(got, "|"), want)
	}
	if evs := diff(next, next); len(evs) != 0 {
		t.Fatalf("快照相同不应产生事件: %v", evs)
	}
}
