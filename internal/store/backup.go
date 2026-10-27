package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"path/filepath"
	"rawmark/internal/i18n"
	"strings"
)

// Snapshot uses SQLite to create a consistent standalone database rather than copying active WAL files.
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
			return nil, i18n.New("invalid_format_for_setting_s_745c8c", key)
		}
		result[key] = json.RawMessage(value)
	}
	return result, rows.Err()
}

// ReplacePreferences commits all preferences together; accounts and sessions are excluded from settings archives.
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
			return i18n.New("settings_contain_an_invalid_entry_90c647")
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

// CheckBackup verifies readability and required tables without initializing or repairing the supplied database.
func (s *Store) CheckBackup() error {
	var result string
	if err := s.db.QueryRow(`PRAGMA quick_check`).Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return i18n.New("backup_database_integrity_check_failed_5adb6a")
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

// OpenExisting opens only existing databases; import validation must not create tables or change journal modes.
func OpenExisting(path string) (*Store, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	uriPath := filepath.ToSlash(absolute)
	if filepath.VolumeName(absolute) != "" && !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	db, err := sql.Open("sqlite", (&url.URL{Scheme: "file", Path: uriPath, RawQuery: "mode=rw&_pragma=busy_timeout(5000)"}).String())
	if err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}
