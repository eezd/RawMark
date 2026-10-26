package search

import (
	"context"
	"database/sql"
	"encoding/json"
	"rawmark/internal/vault"
)

func insert(tx *sql.Tx, p, rev string, content []byte) (int64, error) {
	metadata, err := json.Marshal(vault.Analyze(p, content))
	if err != nil {
		return 0, err
	}
	result, err := tx.Exec(`INSERT INTO docs(path,rev,metadata) VALUES (?,?,?)`, p, rev, string(metadata))
	if err != nil {
		return 0, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	_, err = tx.Exec(`INSERT INTO docs_fts(rowid,path,body) VALUES (?,?,?)`, id, p, string(content))
	return id, err
}

// Rebuild excludes background synchronization; failures leave both the transaction and known snapshot unchanged.
func (x *Index) Rebuild(ctx context.Context) error {
	x.work.Lock()
	defer x.work.Unlock()
	x.mu.Lock()
	version := x.pendingVersion
	x.mu.Unlock()
	entries, err := x.v.Tree()
	if err != nil {
		return err
	}
	tx, err := x.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `DELETE FROM docs_fts; DELETE FROM docs`); err != nil {
		return err
	}
	next := map[string]doc{}
	for _, entry := range entries {
		if entry.Dir || !vault.IsNote(entry.Path) {
			continue
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		content, rev, err := x.v.Read(entry.Path)
		if err != nil {
			return err
		}
		id, err := insert(tx, entry.Path, rev, content)
		if err != nil {
			return err
		}
		next[entry.Path] = doc{id: id, rev: rev}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	x.known = next
	x.mu.Lock()
	if version == x.pendingVersion {
		x.pending = nil
	}
	x.ready = true
	x.lastError = nil
	x.mu.Unlock()
	return nil
}
func (x *Index) Optimize(ctx context.Context) error {
	x.work.Lock()
	defer x.work.Unlock()
	for _, stmt := range []string{`INSERT INTO docs_fts(docs_fts) VALUES ('optimize')`, `PRAGMA wal_checkpoint(TRUNCATE)`, `VACUUM`} {
		if _, err := x.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (x *Index) syncPending() error {
	x.work.Lock()
	defer x.work.Unlock()
	x.mu.Lock()
	files := x.pending
	x.pending = nil
	x.mu.Unlock()
	if files == nil {
		return nil
	}
	return x.syncLocked(files)
}
