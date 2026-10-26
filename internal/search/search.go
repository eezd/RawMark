// Package search maintains a full-text note index in a separate database, derived entirely from vault files.
// A deleted index is rebuilt at startup; structural changes also trigger rebuilding rather than migration.
package search

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"rawmark/internal/i18n"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	_ "modernc.org/sqlite"

	"rawmark/internal/vault"
)

// Increment when schema or derived-metadata parsing changes; old indexes are discarded and rebuilt.
const schemaVersion = 3

const schema = `
CREATE TABLE docs (
  id   INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  rev  TEXT NOT NULL,
  metadata TEXT NOT NULL
);
-- Trigram tokenization needs no word separators and supports Chinese fragments; use LIKE for terms shorter than three characters.
CREATE VIRTUAL TABLE docs_fts USING fts5(path, body, tokenize = 'trigram');
`

const (
	maxTerms      = 8
	snippetRunes  = 160
	snippetBefore = 40
)

type Result struct {
	Path string `json:"path"`
	// First matching line (1-based) and its excerpt; Line is 0 when only the filename matches.
	Line    int    `json:"line"`
	Snippet string `json:"snippet"`
}

type doc struct {
	id  int64
	rev string
}

type Index struct {
	OnIndexed func()
	ready     bool
	lastError error
	db        *sql.DB
	v         *vault.Vault

	mu             sync.Mutex
	pending        map[string]string // Latest pending snapshot (path -> rev).
	wake           chan struct{}
	pendingVersion uint64

	work  sync.Mutex     // Serialize synchronization, rebuilding, and database maintenance.
	known map[string]doc // Indexed notes, accessed only by the synchronization goroutine.
}

func Open(path string, v *vault.Vault) (*Index, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	x := &Index{db: db, v: v, wake: make(chan struct{}, 1), known: map[string]doc{}}
	if err := x.init(); err != nil {
		db.Close()
		return nil, i18n.New("could_not_initialize_search_index_9155c3", err)
	}
	return x, nil
}

func (x *Index) init() error {
	var version int
	if err := x.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version != schemaVersion {
		stmts := []string{`DROP TABLE IF EXISTS docs`, `DROP TABLE IF EXISTS docs_fts`, schema, fmt.Sprintf(`PRAGMA user_version = %d`, schemaVersion)}
		for _, s := range stmts {
			if _, err := x.db.Exec(s); err != nil {
				return err
			}
		}
	}
	rows, err := x.db.Query(`SELECT id, path, rev FROM docs`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var d doc
		var p string
		if err := rows.Scan(&d.id, &p, &d.rev); err != nil {
			return err
		}
		x.known[p] = d
	}
	return rows.Err()
}

func (x *Index) Close() error { return x.db.Close() }

// Update submits the latest vault snapshot (note path -> rev) and returns immediately; background synchronization consumes only the latest submission.
func (x *Index) Update(files map[string]string) {
	x.mu.Lock()
	x.pending = files
	x.pendingVersion++
	x.mu.Unlock()
	select {
	case x.wake <- struct{}{}:
	default:
	}
}

// Run processes background synchronization until ctx ends.
func (x *Index) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-x.wake:
			if err := x.syncPending(); err != nil {
				x.mu.Lock()
				x.lastError = err
				x.mu.Unlock()
				slog.Error("更新搜索索引失败", "err", err)
			} else if x.OnIndexed != nil {
				x.OnIndexed()
			}
		}
	}
}

// sync reconciles the index with the snapshot, reading only new notes or changed revisions.
func (x *Index) sync(files map[string]string) error {
	x.work.Lock()
	defer x.work.Unlock()
	return x.syncLocked(files)
}

func (x *Index) syncLocked(files map[string]string) error {
	tx, err := x.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	next := make(map[string]doc, len(x.known))
	for p, d := range x.known {
		next[p] = d
	}
	for p, d := range x.known {
		if _, ok := files[p]; !ok {
			if err := remove(tx, d.id); err != nil {
				return err
			}
			delete(next, p)
		}
	}
	for p, rev := range files {
		old, ok := x.known[p]
		if ok && old.rev == rev {
			continue
		}
		content, rev, err := x.v.Read(p)
		if errors.Is(err, vault.ErrNotFound) {
			continue // Deleted after the snapshot; the next snapshot will handle it.
		}
		if err != nil {
			return err
		}
		if ok {
			if err := remove(tx, old.id); err != nil {
				return err
			}
		}
		id, err := insert(tx, p, rev, content)
		if err != nil {
			return err
		}
		next[p] = doc{id: id, rev: rev}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	x.known = next
	x.mu.Lock()
	x.ready = true
	x.lastError = nil
	x.mu.Unlock()
	return nil
}

func remove(tx *sql.Tx, id int64) error {
	if _, err := tx.Exec(`DELETE FROM docs WHERE id = ?`, id); err != nil {
		return err
	}
	_, err := tx.Exec(`DELETE FROM docs_fts WHERE rowid = ?`, id)
	return err
}

// Search finds notes containing every whitespace-separated term, case-insensitively, in paths or contents.
// Path matches (file or folder names) for the first term rank first; remaining results sort by relevance.
func (x *Index) Search(query string, limit int) ([]Result, error) {
	terms := strings.Fields(query)
	if len(terms) == 0 {
		return []Result{}, nil
	}
	if len(terms) > maxTerms {
		terms = terms[:maxTerms]
	}
	var where, phrases []string
	var args []any
	for _, t := range terms {
		if utf8.RuneCountInString(t) >= 3 {
			phrases = append(phrases, `"`+strings.ReplaceAll(t, `"`, `""`)+`"`)
		} else {
			like := "%" + escapeLike(t) + "%"
			where = append(where, `(path LIKE ? ESCAPE '\' OR body LIKE ? ESCAPE '\')`)
			args = append(args, like, like)
		}
	}
	order := "path"
	if len(phrases) > 0 {
		where = append(where, `docs_fts MATCH ?`)
		args = append(args, strings.Join(phrases, " AND "))
		order = "rank"
	}
	name := "%" + escapeLike(terms[0]) + "%"
	q := `SELECT path, body FROM docs_fts WHERE ` + strings.Join(where, " AND ") +
		` ORDER BY path LIKE ? ESCAPE '\' DESC, ` + order + ` LIMIT ?`
	args = append(args, name, limit)
	rows, err := x.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := []Result{}
	for rows.Next() {
		var r Result
		var body string
		if err := rows.Scan(&r.Path, &body); err != nil {
			return nil, err
		}
		r.Line, r.Snippet = snippet(body, terms)
		results = append(results, r)
	}
	return results, rows.Err()
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// snippet returns the first matching line number and an excerpt, truncating long lines around the match.
func snippet(body string, terms []string) (int, string) {
	folded := make([][]rune, len(terms))
	for i, t := range terms {
		folded[i] = fold([]rune(t))
	}
	for n, line := range strings.Split(body, "\n") {
		runes := []rune(strings.TrimRight(line, "\r"))
		lower := fold(runes)
		at := -1
		for _, t := range folded {
			if i := indexRunes(lower, t); i >= 0 && (at < 0 || i < at) {
				at = i
			}
		}
		if at < 0 {
			continue
		}
		start := 0
		if len(runes) > snippetRunes {
			start = max(0, min(at-snippetBefore, len(runes)-snippetRunes))
		}
		end := min(len(runes), start+snippetRunes)
		text := strings.TrimSpace(string(runes[start:end]))
		if start > 0 {
			text = "…" + text
		}
		if end < len(runes) {
			text += "…"
		}
		return n + 1, text
	}
	return 0, ""
}

// fold lowercases rune by rune, preserving character count for slicing the original text by position.
func fold(rs []rune) []rune {
	out := make([]rune, len(rs))
	for i, r := range rs {
		out[i] = unicode.ToLower(r)
	}
	return out
}

func indexRunes(s, sub []rune) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		match := true
		for j := range sub {
			if s[i+j] != sub[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

type NoteMetadata struct {
	Path string `json:"path"`
	Rev  string `json:"rev"`
	vault.Metadata
}

func (x *Index) Metadata() ([]NoteMetadata, bool, error) {
	x.mu.Lock()
	ready, lastError := x.ready, x.lastError
	x.mu.Unlock()
	if lastError != nil {
		return nil, ready, lastError
	}
	notes := []NoteMetadata{}
	rows, err := x.db.Query(`SELECT path, rev, metadata FROM docs ORDER BY path`)
	if err != nil {
		return nil, ready, err
	}
	defer rows.Close()
	for rows.Next() {
		var note NoteMetadata
		var data string
		if err := rows.Scan(&note.Path, &note.Rev, &data); err != nil {
			return nil, ready, err
		}
		if err := json.Unmarshal([]byte(data), &note.Metadata); err != nil {
			return nil, ready, err
		}
		notes = append(notes, note)
	}
	return notes, ready, rows.Err()
}
