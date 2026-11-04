package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenExistingUsesNativeEscapedPathWithoutCreating(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "数据库 # %.db")
	original, err := Open(filepath.Join(root, "source.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := original.SetSetting("portable", "retained"); err != nil {
		t.Fatal(err)
	}
	if err := original.Snapshot(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	if err := original.Close(); err != nil {
		t.Fatal(err)
	}
	existing, err := OpenExisting(path)
	if err != nil {
		t.Fatal(err)
	}
	value, ok, err := existing.Setting("portable")
	if err != nil || !ok || value != "retained" {
		t.Fatalf("existing database path: %q, %v, %v", value, ok, err)
	}
	if err := existing.Close(); err != nil {
		t.Fatal(err)
	}
	missingPath := filepath.Join(root, "missing.db")
	missing, err := OpenExisting(missingPath)
	if err != nil {
		t.Fatal(err)
	}
	defer missing.Close()
	if _, _, err := missing.Setting("portable"); err == nil {
		t.Fatal("missing database accepted")
	}
	if _, err := os.Stat(missingPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing database was created: %v", err)
	}
}

func TestResetPreferencesRollsBackIfPinResetFails(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "rawmark.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	original := map[string]string{
		"app.settings":    `{"fontSize":24,"pinnedTabs":["note.md"]}`,
		"plugins.enabled": `{"example":true}`,
	}
	for key, value := range original {
		if err := st.SetSetting(key, value); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.db.Exec(`CREATE TRIGGER reject_pin_reset BEFORE INSERT ON settings WHEN NEW.key='app.settings' BEGIN SELECT RAISE(ABORT,'intentional reset failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := st.ResetPreferences(); err == nil {
		t.Fatal("固定标签重置失败必须返回错误")
	}
	for key, value := range original {
		if got, ok, err := st.Setting(key); err != nil || !ok || got != value {
			t.Fatalf("重置失败未回滚 %s: %q, %v", key, got, err)
		}
	}
}
