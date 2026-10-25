package backup

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"rawmark/internal/store"
)

// RestoreRecord 必须在关闭 HTTP、文件监听、索引和数据库之后执行。
// prepared 尚未改动活动数据，applying 表示上次中断，必须先回退。
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
	// 先检查文件签名，Open 的 schema 初始化不能将错误文件伪装为新实例。
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	header := make([]byte, 16)
	_, err = io.ReadFull(f, header)
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if string(header) != "SQLite format 3\x00" {
		return fmt.Errorf("备份数据库格式无效")
	}
	st, err := store.OpenExisting(file)
	if err != nil {
		return err
	}
	defer st.Close()
	if err = st.CheckBackup(); err != nil {
		return err
	}
	password, ok, err := st.Setting("auth.password")
	if err != nil {
		return err
	}
	parts := strings.Split(password, "$")
	if !ok || len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" || parts[3] != "m=65536,t=3,p=4" {
		return fmt.Errorf("备份密码格式不受支持")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) != 16 {
		return fmt.Errorf("备份密码盐无效")
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(key) != 32 {
		return fmt.Errorf("备份密码校验值无效")
	}
	return nil
}

// VaultExcluded 支持外置与嵌套仓库，避免将应用文件重复备份为笔记。
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

// CopyTree 不覆盖任何已有目标，也不允许跟随链接。
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
			return fmt.Errorf("不允许复制特殊文件")
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
		// data 在某个祖先目录内时保留祖先，只清理其余子项。
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

// Recover 在启动时完成预先确认的恢复；若中断或失败，使用操作前备份回退。
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
		return fmt.Errorf("恢复记录状态无效")
	}
	// 记录由本机生成；仍限制其读取范围，避免错误记录读取任意文件。
	if !strings.HasPrefix(record.Stage, filepath.Join(data, ".maintenance", "uploads")+string(filepath.Separator)) || !strings.HasPrefix(record.Backup, filepath.Join(data, "backups")+string(filepath.Separator)) {
		return fmt.Errorf("恢复记录路径无效")
	}
	if record.Kind == "settings" {
		return recoverSettings(data, record)
	}
	if record.State != "prepared" {
		err = fmt.Errorf("上次实例恢复被中断")
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
		return errors.Join(err, fmt.Errorf("实例回退失败: %w", restoreErr))
	}
	if removeErr := os.Remove(recordPath(data)); removeErr != nil {
		return errors.Join(err, removeErr)
	}
	if err != nil {
		return fmt.Errorf("导入恢复失败，已回退原实例: %w", err)
	}
	return nil
}

// FinishRecovery 在新实例的索引、监听与端口初始化成功后提交恢复。
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
		return fmt.Errorf("恢复尚未完成初始化")
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
	return fmt.Errorf("设置导入被中断，已回退原设置和资源")
}
