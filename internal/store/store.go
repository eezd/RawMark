// Package store 保存应用自身的数据（设置、会话、分享、API 令牌）。笔记内容不在这里，见 vault。
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- 分享链接中的令牌明文保存：管理列表需要随时复制链接，令牌本身即访问凭据，与笔记同等敏感
CREATE TABLE IF NOT EXISTS shares (
  token         TEXT PRIMARY KEY,
  path          TEXT NOT NULL,
  password_hash TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shares_path ON shares(path);
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0
);
`

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("初始化数据库失败: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Setting 读取设置项；不存在时 ok 为 false
func (s *Store) Setting(key string) (value string, ok bool, err error) {
	err = s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return value, err == nil, err
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// SetSettingIfAbsent 仅在设置项不存在时写入，返回是否写入成功（用于首次初始化，防止并发重复设置）
func (s *Store) SetSettingIfAbsent(key, value string) (bool, error) {
	res, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`, key, value)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

func (s *Store) CreateSession(tokenHash string, expires time.Time) error {
	_, err := s.db.Exec(`INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)`,
		tokenHash, time.Now().Unix(), expires.Unix())
	return err
}

// SessionValid 校验会话未过期，并顺延有效期（滑动过期）
func (s *Store) SessionValid(tokenHash string, extendTo time.Time) (bool, error) {
	res, err := s.db.Exec(`UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ?`,
		extendTo.Unix(), tokenHash, time.Now().Unix())
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

func (s *Store) DeleteSession(tokenHash string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

func (s *Store) DeleteAllSessions() error {
	_, err := s.db.Exec(`DELETE FROM sessions`)
	return err
}

func (s *Store) DeleteExpiredSessions() error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE expires_at <= ?`, time.Now().Unix())
	return err
}

// ---- 分享 ----

// Share 为一个只读分享链接。时间均为 Unix 毫秒，ExpiresAt 为 0 表示永久有效
type Share struct {
	Token        string `json:"token"`
	Path         string `json:"path"`
	PasswordHash string `json:"-"`
	CreatedAt    int64  `json:"createdAt"`
	ExpiresAt    int64  `json:"expiresAt"`
}

func (s *Store) CreateShare(sh Share) error {
	_, err := s.db.Exec(`INSERT INTO shares (token, path, password_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		sh.Token, sh.Path, sh.PasswordHash, sh.CreatedAt, sh.ExpiresAt)
	return err
}

// GetShare 按令牌读取分享；不存在时 ok 为 false
func (s *Store) GetShare(token string) (sh Share, ok bool, err error) {
	err = s.db.QueryRow(`SELECT token, path, password_hash, created_at, expires_at FROM shares WHERE token = ?`, token).
		Scan(&sh.Token, &sh.Path, &sh.PasswordHash, &sh.CreatedAt, &sh.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Share{}, false, nil
	}
	return sh, err == nil, err
}

// Shares 列出全部分享，最新的在前
func (s *Store) Shares() ([]Share, error) {
	rows, err := s.db.Query(`SELECT token, path, password_hash, created_at, expires_at FROM shares ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Share{}
	for rows.Next() {
		var sh Share
		if err := rows.Scan(&sh.Token, &sh.Path, &sh.PasswordHash, &sh.CreatedAt, &sh.ExpiresAt); err != nil {
			return nil, err
		}
		out = append(out, sh)
	}
	return out, rows.Err()
}

// DeleteShare 返回是否删除了记录
func (s *Store) DeleteShare(token string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM shares WHERE token = ?`, token)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

// MoveShares 让分享跟随笔记移动：from 为笔记时只改它自己，为文件夹时改其下所有笔记
func (s *Store) MoveShares(from, to string) error {
	_, err := s.db.Exec(`UPDATE shares SET path = CASE WHEN path = ?1 THEN ?2 ELSE ?2 || substr(path, length(?1) + 1) END
		WHERE path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/'`, from, to)
	return err
}

// ---- API 令牌 ----

// APIToken 为自动化调用的访问令牌，只保存哈希。Scope 为 read 或 write
type APIToken struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Hash       string `json:"-"`
	Scope      string `json:"scope"`
	CreatedAt  int64  `json:"createdAt"`
	LastUsedAt int64  `json:"lastUsedAt"`
}

func (s *Store) CreateAPIToken(t APIToken) error {
	_, err := s.db.Exec(`INSERT INTO api_tokens (id, name, token_hash, scope, created_at) VALUES (?, ?, ?, ?, ?)`,
		t.ID, t.Name, t.Hash, t.Scope, t.CreatedAt)
	return err
}

func (s *Store) APITokens() ([]APIToken, error) {
	rows, err := s.db.Query(`SELECT id, name, scope, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIToken{}
	for rows.Next() {
		var t APIToken
		if err := rows.Scan(&t.ID, &t.Name, &t.Scope, &t.CreatedAt, &t.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// UseAPIToken 按哈希查找令牌并记录使用时间；不存在时 ok 为 false
func (s *Store) UseAPIToken(hash string, now int64) (scope string, ok bool, err error) {
	err = s.db.QueryRow(`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ? RETURNING scope`, now, hash).Scan(&scope)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return scope, err == nil, err
}

func (s *Store) DeleteAPIToken(id string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM api_tokens WHERE id = ?`, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}
