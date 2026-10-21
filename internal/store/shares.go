package store

import "database/sql"

const shareSchema = `
-- 分享令牌是可复制的访问凭据，与笔记同等敏感。
CREATE TABLE IF NOT EXISTS shares (
 token TEXT PRIMARY KEY,
 password_hash TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS share_items (
 share_token TEXT NOT NULL REFERENCES shares(token) ON DELETE CASCADE,
 item_id INTEGER NOT NULL,
 path TEXT NOT NULL,
 PRIMARY KEY (share_token,item_id)
);
CREATE INDEX IF NOT EXISTS share_items_path ON share_items(path);
`

// 仅迁移项目已有的单路径表；事务保证中断或失败时仍保留原格式。
func migrateShares(db *sql.DB) error {
	var legacy bool
	if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM pragma_table_info('shares') WHERE name = 'path')`).Scan(&legacy); err != nil {
		return err
	}
	if !legacy {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`ALTER TABLE shares RENAME TO shares_legacy;` + shareSchema + `
 INSERT INTO shares(token,password_hash,created_at,expires_at) SELECT token,password_hash,created_at,expires_at FROM shares_legacy;
 INSERT INTO share_items(share_token,item_id,path) SELECT token,0,path FROM shares_legacy;
 DROP TABLE shares_legacy;`); err != nil {
		return err
	}
	return tx.Commit()
}
