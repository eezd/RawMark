package backup

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"rawmark/internal/i18n"
	"strings"

	"rawmark/internal/store"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// RestoreRecord must run after HTTP, file watching, indexing, and databases have shut down.
// prepared means active data is unchanged; applying indicates an interrupted restore that must first roll back.
type RestoreRecord struct {
	State  string `json:"state"`
	Kind   string `json:"kind,omitempty"`
	Stage  string `json:"stage"`
	Backup string `json:"backup"`
}

func recordPath(data string) string { return filepath.Join(data, ".maintenance", "restore.json") }
func WriteRecord(data string, record RestoreRecord) error {
	bytes, err := json.Marshal(record)
	if err != nil {
		return err
	}
	dest := recordPath(data)
	if err = os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(dest), "record-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(bytes)
	}
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), dest); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(dest))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func Pending(data string) (bool, error) {
	_, err := os.Stat(recordPath(data))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func CheckDatabase(file string) error {
	// Check file signatures first so Open's schema initialization cannot disguise an invalid file as a new instance.
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	header := make([]byte, 16)
	_, err = io.ReadFull(f, header)
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		err = i18n.New("w_w_f0fd7d", ErrInvalidArchive, err)
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if string(header) != "SQLite format 3\x00" {
		return i18n.New("w_invalid_backup_database_format_d45d60", ErrInvalidArchive)
	}
	st, err := store.OpenExisting(file)
	if err != nil {
		return err
	}
	defer st.Close()
	if err = st.CheckBackup(); err != nil {
		var databaseError *sqlite.Error
		if errors.As(err, &databaseError) {
			switch databaseError.Code() & 0xff {
			case sqlite3.SQLITE_ERROR, sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB:
			default:
				return err
			}
		}
		return i18n.New("w_w_f0fd7d", ErrInvalidArchive, err)
	}
	password, ok, err := st.Setting("auth.password")
	if err != nil {
		return err
	}
	parts := strings.Split(password, "$")
	if !ok || len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" || parts[3] != "m=65536,t=3,p=4" {
		return i18n.New("w_unsupported_backup_password_format_184d32", ErrInvalidArchive)
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) != 16 {
		return i18n.New("w_invalid_backup_password_salt_315eca", ErrInvalidArchive)
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(key) != 32 {
		return i18n.New("w_invalid_backup_password_verification_17d1c1", ErrInvalidArchive)
	}
	return nil
}

// VaultExcluded supports external and nested vaults, avoiding duplicate application files in note backups.
func VaultExcluded(data, vault, rel string) bool {
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if strings.HasPrefix(part, ".rawmark-tmp-") {
			return true
		}
	}
	full := filepath.Join(vault, filepath.FromSlash(rel))
	data, _ = filepath.Abs(data)
	vault, _ = filepath.Abs(vault)
	if data == vault {
		top := strings.Split(filepath.ToSlash(rel), "/")[0]
		switch top {
		case "rawmark.db", "rawmark.db-wal", "rawmark.db-shm", "index.db", "index.db-wal", "index.db-shm", "fonts", "themes", "plugins", "logs", "temp", "backups", ".maintenance":
			return true
		}
	} else if strings.HasPrefix(data, vault+string(filepath.Separator)) && (full == data || strings.HasPrefix(full, data+string(filepath.Separator))) {
		return true
	}
	return false
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err = os.MkdirAll(filepath.Dir(dst), 0700); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Sync()
	}
	return errors.Join(err, out.Close())
}

// CopyTree never overwrites an existing destination or follows symlinks.
func CopyTree(src, dest string) error {
	return filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return i18n.New("special_files_cannot_be_copied_441836")
		}
		if err = copyFile(p, target, 0600); err != nil {
			return err
		}
		return os.Chtimes(target, info.ModTime(), info.ModTime())
	})
}
func clearVault(data, root, dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		full := filepath.Join(dir, entry.Name())
		rel, err := filepath.Rel(root, full)
		if err != nil {
			return err
		}
		if VaultExcluded(data, root, rel) {
			continue
		}
		// When data lies inside an ancestor directory, keep that ancestor and clean only the other children.
		if entry.IsDir() && strings.HasPrefix(data, full+string(filepath.Separator)) {
			if err = clearVault(data, root, full); err != nil {
				return err
			}
			continue
		}
		if err = os.RemoveAll(full); err != nil {
			return err
		}
	}
	return nil
}
func apply(data, vault, stage string) error {
	if err := clearVault(data, vault, vault); err != nil {
		return err
	}
	if err := CopyTree(filepath.Join(stage, "vault"), vault); err != nil {
		return err
	}
	for _, name := range []string{"rawmark.db", "rawmark.db-wal", "rawmark.db-shm", "index.db", "index.db-wal", "index.db-shm", "fonts", "themes", "plugins"} {
		dest := filepath.Join(data, name)
		if err := os.RemoveAll(dest); err != nil {
			return err
		}
		source := filepath.Join(stage, "app", name)
		info, err := os.Stat(source)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if info.IsDir() {
			err = CopyTree(source, dest)
		} else {
			err = copyFile(source, dest, 0600)
		}
		if err != nil {
			return err
		}
	}
	if err := CheckDatabase(filepath.Join(data, "rawmark.db")); err != nil {
		return err
	}
	st, err := store.OpenExisting(filepath.Join(data, "rawmark.db"))
	if err != nil {
		return err
	}
	err = st.ClearSessions()
	return errors.Join(err, st.Close())
}

// Recover performs a previously confirmed restore at startup, reverting to the pre-operation backup on interruption or failure.
func Recover(data, vault string) (err error) {
	raw, err := os.ReadFile(recordPath(data))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var record RestoreRecord
	if err = json.Unmarshal(raw, &record); err != nil {
		return err
	}
	if record.State != "prepared" && record.State != "applying" && record.State != "verifying" {
		return i18n.New("invalid_restore_record_state_eee063")
	}
	// The record is locally generated, but restrict its read scope to prevent malformed records from reading arbitrary files.
	if !strings.HasPrefix(record.Stage, filepath.Join(data, ".maintenance", "uploads")+string(filepath.Separator)) || !strings.HasPrefix(record.Backup, filepath.Join(data, "backups")+string(filepath.Separator)) {
		return i18n.New("invalid_restore_record_path_611881")
	}
	if record.Kind == "settings" {
		return recoverSettings(data, record)
	}
	if record.State != "prepared" {
		err = i18n.New("the_previous_instance_restore_was_a9d480")
	}
	if record.State == "prepared" {
		record.State = "applying"
		if err = WriteRecord(data, record); err != nil {
			return err
		}
		if err = apply(data, vault, record.Stage); err == nil {
			record.State = "verifying"
			return WriteRecord(data, record)
		}
	}
	stage, stageErr := os.MkdirTemp(filepath.Join(data, ".maintenance"), "rollback-")
	if stageErr != nil {
		return errors.Join(err, stageErr)
	}
	defer os.RemoveAll(stage)
	_, restoreErr := Extract(context.Background(), record.Backup, stage)
	if restoreErr == nil {
		restoreErr = apply(data, vault, stage)
	}
	if restoreErr != nil {
		return errors.Join(err, i18n.New("instance_rollback_failed_w_80ec77", restoreErr))
	}
	if removeErr := os.Remove(recordPath(data)); removeErr != nil {
		return errors.Join(err, removeErr)
	}
	if err != nil {
		return i18n.New("restore_failed_original_instance_restored_c03846", err)
	}
	return nil
}

// FinishRecovery commits the restore after the new instance's index, watcher, and listener initialize successfully.
func FinishRecovery(data string) error {
	raw, err := os.ReadFile(recordPath(data))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var record RestoreRecord
	if err = json.Unmarshal(raw, &record); err != nil {
		return err
	}
	if record.State != "verifying" {
		return i18n.New("the_restored_instance_has_not_5ca7fb")
	}
	if err = os.RemoveAll(filepath.Dir(record.Stage)); err != nil {
		return err
	}
	return os.Remove(recordPath(data))
}

func RemoveRecord(data string) error { return os.Remove(recordPath(data)) }
func recoverSettings(data string, record RestoreRecord) error {
	stage, err := os.MkdirTemp(filepath.Join(data, ".maintenance"), "settings-rollback-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if _, err = Extract(context.Background(), record.Backup, stage); err != nil {
		return err
	}
	for _, kind := range []string{"fonts", "themes", "plugins"} {
		target := filepath.Join(data, kind)
		if err = os.RemoveAll(target); err != nil {
			return err
		}
		source := filepath.Join(stage, "app", kind)
		if _, err = os.Stat(source); errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if err = CopyTree(source, target); err != nil {
			return err
		}
	}
	raw, err := os.ReadFile(filepath.Join(stage, "settings.json"))
	if err != nil {
		return err
	}
	var values map[string]json.RawMessage
	if err = json.Unmarshal(raw, &values); err != nil {
		return err
	}
	st, err := store.OpenExisting(filepath.Join(data, "rawmark.db"))
	if err != nil {
		return err
	}
	err = st.ReplacePreferences(values)
	err = errors.Join(err, st.Close())
	if err != nil {
		return err
	}
	if err = os.Remove(recordPath(data)); err != nil {
		return err
	}
	return i18n.New("settings_import_was_interrupted_original_417ef5")
}
