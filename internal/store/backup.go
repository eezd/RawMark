package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// Snapshot 使用 SQLite 生成一致的独立数据库，不复制活动 WAL 文件。
func (s *Store) Snapshot(ctx context.Context, dest string) error {
	_, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, dest)
	return err
}
func (s *Store) Preferences() (map[string]json.RawMessage, error) {
	rows, err := s.db.Query(`SELECT key,value FROM settings WHERE key IN ('app.settings','plugins.enabled') OR key GLOB 'plugin.data.*' ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]json.RawMessage{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		if !json.Valid([]byte(value)) {
			return nil, fmt.Errorf("设置 %s 格式无效", key)
		}
		result[key] = json.RawMessage(value)
	}
	return result, rows.Err()
}

// ReplacePreferences 一次提交全部偏好，账户与会话不属于设置包。
func (s *Store) ReplacePreferences(values map[string]json.RawMessage) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM settings WHERE key IN ('app.settings','plugins.enabled') OR key GLOB 'plugin.data.*'`); err != nil {
		return err
	}
	for key, value := range values {
		if (key != "app.settings" && key != "plugins.enabled" && !strings.HasPrefix(key, "plugin.data.")) || !json.Valid(value) {
			return fmt.Errorf("设置包含无效设置项")
		}
		if _, err = tx.Exec(`INSERT INTO settings(key,value) VALUES (?,?)`, key, string(value)); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) ResetPreferences() error {
	_, err := s.db.Exec(`DELETE FROM settings WHERE key IN ('app.settings','plugins.enabled')`)
	return err
}
func (s *Store) ClearSessions() error { _, err := s.db.Exec(`DELETE FROM sessions`); return err }

// CheckBackup 确认数据库可读取且包含当前版本所需表；不会初始化或修复传入文件。
func (s *Store) CheckBackup() error {
	var result string
	if err := s.db.QueryRow(`PRAGMA quick_check`).Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return errors.New("备份数据库完整性检查失败")
	}
	for _, query := range []string{`SELECT key,value FROM settings LIMIT 0`, `SELECT token_hash,created_at,expires_at FROM sessions LIMIT 0`, `SELECT id,name,token_hash,scope,created_at,last_used_at FROM api_tokens LIMIT 0`} {
		rows, err := s.db.Query(query)
		if err != nil {
			return err
		}
		if err = rows.Close(); err != nil {
			return err
		}
	}
	return nil
}

// OpenExisting 只打开已有库；导入校验不得创建表或更改日志模式。
func OpenExisting(path string) (*Store, error) {
	db, err := sql.Open("sqlite", (&url.URL{Scheme: "file", Path: path, RawQuery: "mode=rw&_pragma=busy_timeout(5000)"}).String())
	if err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}
