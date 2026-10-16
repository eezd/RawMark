package search

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rawmark/internal/vault"
)

type fixture struct {
	t   *testing.T
	v   *vault.Vault
	idx *Index
	db  string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	v, err := vault.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, v: v, db: filepath.Join(t.TempDir(), "index.db")}
	f.reopen()
	return f
}

func (f *fixture) reopen() {
	if f.idx != nil {
		f.idx.Close()
	}
	idx, err := Open(f.db, f.v)
	if err != nil {
		f.t.Fatal(err)
	}
	f.idx = idx
	f.t.Cleanup(func() { idx.Close() })
}

func (f *fixture) write(p, content string) {
	abs := filepath.Join(f.v.Root(), p)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

// sync 模拟监听器提交快照
func (f *fixture) sync() {
	f.t.Helper()
	entries, err := f.v.Tree()
	if err != nil {
		f.t.Fatal(err)
	}
	files := map[string]string{}
	for _, e := range entries {
		if !e.Dir {
			data, _, err := f.v.Read(e.Path)
			if err != nil {
				f.t.Fatal(err)
			}
			files[e.Path] = vault.Rev(data)
		}
	}
	if err := f.idx.sync(files); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) paths(q string) string {
	f.t.Helper()
	rs, err := f.idx.Search(q, 50)
	if err != nil {
		f.t.Fatalf("搜索 %q: %v", q, err)
	}
	var out []string
	for _, r := range rs {
		out = append(out, r.Path)
	}
	return strings.Join(out, ",")
}

func TestSearchTerms(t *testing.T) {
	f := newFixture(t)
	f.write("a.md", "# 标题\n\n今天学习 CodeMirror 的装饰器\n")
	f.write("b.md", "第二篇笔记，讲 SQLite 全文检索\n")
	f.write("目录/c.md", "装饰器和检索都提到\n")
	f.sync()

	cases := map[string]string{
		"装饰器":           "a.md,目录/c.md", // 3 个字符以上走 FTS
		"检索":            "b.md,目录/c.md", // 不足 3 个字符走 LIKE
		"codemirror":    "a.md",          // 不区分大小写
		"装饰器 检索":        "目录/c.md",       // 多个词同时满足
		"目录":            "目录/c.md",       // 命中路径
		"不存在的词":         "",
		"100%":          "",
		`"引号"`:          "",
		"   ":           "",
	}
	for q, want := range cases {
		if got := f.paths(q); got != want && !(strings.Contains(want, ",") && sameSet(got, want)) {
			t.Errorf("搜索 %q = %q，期望 %q", q, got, want)
		}
	}
}

func sameSet(a, b string) bool {
	as, bs := strings.Split(a, ","), strings.Split(b, ",")
	if len(as) != len(bs) {
		return false
	}
	seen := map[string]bool{}
	for _, s := range as {
		seen[s] = true
	}
	for _, s := range bs {
		if !seen[s] {
			return false
		}
	}
	return true
}

func TestSearchRanksNameMatchFirstAndReturnsSnippet(t *testing.T) {
	f := newFixture(t)
	f.write("其他.md", "第一行\n这里提到部署流程\n")
	f.write("部署流程.md", "正文无关\n")
	f.write("长行.md", strings.Repeat("前", 300)+"关键字"+strings.Repeat("后", 300))
	f.sync()

	rs, err := f.idx.Search("部署流程", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(rs) != 2 || rs[0].Path != "部署流程.md" || rs[0].Line != 0 {
		t.Fatalf("文件名命中应排第一且无正文摘录: %+v", rs)
	}
	if rs[1].Line != 2 || rs[1].Snippet != "这里提到部署流程" {
		t.Fatalf("摘录错误: %+v", rs[1])
	}

	rs, _ = f.idx.Search("关键字", 50)
	s := rs[0].Snippet
	if !strings.HasPrefix(s, "…") || !strings.HasSuffix(s, "…") || !strings.Contains(s, "关键字") || len([]rune(s)) > snippetRunes+2 {
		t.Fatalf("长行摘录应截取匹配附近: %q", s)
	}
}

func TestSyncTracksChanges(t *testing.T) {
	f := newFixture(t)
	f.write("a.md", "旧内容")
	f.write("b.md", "保留")
	f.sync()

	f.write("a.md", "新内容")
	if err := os.Remove(filepath.Join(f.v.Root(), "b.md")); err != nil {
		t.Fatal(err)
	}
	f.write("c.md", "新增")
	f.sync()
	for q, want := range map[string]string{"旧内容": "", "新内容": "a.md", "保留": "", "新增": "c.md"} {
		if got := f.paths(q); got != want {
			t.Errorf("搜索 %q = %q，期望 %q", q, got, want)
		}
	}

	// 重启后沿用已有索引，只处理变化
	f.reopen()
	if len(f.idx.known) != 2 {
		t.Fatalf("重启后应载入已索引笔记: %v", f.idx.known)
	}
	f.sync()
	if got := f.paths("新内容"); got != "a.md" {
		t.Errorf("重启后搜索 = %q", got)
	}
}
