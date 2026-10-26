// Package backup 处理 RawMark 自有的实例与设置归档；普通 Markdown 导出由 vault 负责。
package backup

import (
	"archive/zip"
	"compress/flate"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"rawmark/internal/i18n"
	"strings"
	"syscall"
	"time"
)

const MaxArchiveBytes int64 = 2 << 30
const MaxExpandedBytes int64 = 8 << 30
const MaxEntries = 100000

// ErrInvalidArchive 表示归档内容不满足备份契约，不包含磁盘或文件系统故障。
var ErrInvalidArchive = i18n.New("invalid_backup_contents_ecff07")

type Entry struct {
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256,omitempty"`
	Dir      bool   `json:"dir,omitempty"`
	Modified int64  `json:"modified"`
}
type Manifest struct {
	Format    int     `json:"format"`
	Kind      string  `json:"kind"`
	CreatedAt int64   `json:"createdAt"`
	Entries   []Entry `json:"entries"`
}
type Source struct{ Name, Path string }

func validPath(name string) bool {
	return name != "" && path.Clean(name) == name && name != "." && !strings.HasPrefix(name, "/") && name != ".." && !strings.HasPrefix(name, "../") && !strings.ContainsAny(name, "\\\x00")
}
func validEntry(kind, name string) bool {
	if !validPath(name) {
		return false
	}
	for _, prefix := range []string{"app/fonts", "app/themes", "app/plugins"} {
		if name == prefix || strings.HasPrefix(name, prefix+"/") {
			return true
		}
	}
	if kind == "full" {
		return name == "app/rawmark.db" || name == "vault" || strings.HasPrefix(name, "vault/")
	}
	return kind == "settings" && name == "settings.json"
}

// Create 不追踪符号链接，任何无法读取的文件都使备份明确失败。
func Create(ctx context.Context, dest, kind string, sources []Source, skip func(string) bool) (err error) {
	if kind != "full" && kind != "settings" {
		return i18n.New("invalid_backup_type_f5ff70")
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, f.Close())
		if err != nil {
			os.Remove(dest)
		}
	}()
	z := zip.NewWriter(f)
	manifest := Manifest{Format: 1, Kind: kind, CreatedAt: time.Now().UnixMilli(), Entries: []Entry{}}
	names := map[string]bool{}
	var total int64
	for _, source := range sources {
		err = filepath.WalkDir(source.Path, func(full string, d os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			rel, err := filepath.Rel(source.Path, full)
			if err != nil {
				return err
			}
			name := source.Name
			if rel != "." {
				name += "/" + filepath.ToSlash(rel)
			}
			if skip != nil && skip(name) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if !validEntry(kind, name) || names[name] {
				return i18n.New("invalid_or_duplicate_backup_path_ce9c5b", name)
			}
			names[name] = true
			info, err := d.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() && !info.IsDir() {
				return i18n.New("backups_do_not_support_symlinks_872adf", name)
			}
			e := Entry{Path: name, Dir: info.IsDir(), Modified: info.ModTime().UnixMilli()}
			if len(manifest.Entries) >= MaxEntries {
				return i18n.New("backup_file_count_exceeds_the_77ac37")
			}
			h, err := zip.FileInfoHeader(info)
			if err != nil {
				return err
			}
			h.Name = name
			h.Method = zip.Deflate
			if e.Dir {
				h.Name += "/"
			}
			out, err := z.CreateHeader(h)
			if err != nil {
				return err
			}
			if !e.Dir {
				in, err := os.Open(full)
				if err != nil {
					return err
				}
				sum := sha256.New()
				e.Size, err = io.Copy(io.MultiWriter(out, sum), io.LimitReader(in, MaxExpandedBytes-total+1))
				err = errors.Join(err, in.Close())
				if err != nil {
					return err
				}
				total += e.Size
				if total > MaxExpandedBytes {
					return i18n.New("expanded_backup_exceeds_gib_b38d18")
				}
				if e.Size != info.Size() {
					return i18n.New("a_file_changed_during_backup_a85244", name)
				}
				after, err := os.Stat(full)
				if err != nil {
					return err
				}
				if !os.SameFile(info, after) || !info.ModTime().Equal(after.ModTime()) || info.Size() != after.Size() {
					return i18n.New("a_file_changed_during_backup_a85244", name)
				}
				e.SHA256 = hex.EncodeToString(sum.Sum(nil))
			}
			manifest.Entries = append(manifest.Entries, e)
			return nil
		})
		if err != nil {
			return err
		}
	}
	out, err := z.Create("manifest.json")
	if err != nil {
		return err
	}
	if err = json.NewEncoder(out).Encode(manifest); err != nil {
		return err
	}
	if err = z.Close(); err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > MaxArchiveBytes {
		return i18n.New("compressed_backup_exceeds_gib_3962d5")
	}
	return f.Sync()
}

// Extract 在私有暂存目录校验完整清单和全部文件哈希，绝不写入活动数据目录。
func Extract(ctx context.Context, archive, dest string) (Manifest, error) {
	var manifest Manifest
	z, err := zip.OpenReader(archive)
	if errors.Is(err, zip.ErrInsecurePath) {
		z.Close()
		return manifest, i18n.New("w_w_f0fd7d", ErrInvalidArchive, err)
	}
	if errors.Is(err, zip.ErrFormat) {
		return manifest, i18n.New("w_w_f0fd7d", ErrInvalidArchive, err)
	}
	if err != nil {
		return manifest, err
	}
	defer z.Close()
	if len(z.File) > MaxEntries+1 {
		return manifest, i18n.New("w_backup_file_count_exceeds_5ba1d4", ErrInvalidArchive)
	}
	entries := map[string]*zip.File{}
	for _, f := range z.File {
		name := strings.TrimSuffix(f.Name, "/")
		if !validPath(name) || entries[name] != nil {
			return manifest, i18n.New("w_invalid_or_duplicate_archive_c11ac2", ErrInvalidArchive)
		}
		if !f.Mode().IsRegular() && !f.Mode().IsDir() {
			return manifest, i18n.New("w_archives_cannot_contain_symlinks_fd836b", ErrInvalidArchive)
		}
		entries[name] = f
	}
	m := entries["manifest.json"]
	if m == nil || m.UncompressedSize64 > 32<<20 {
		return manifest, i18n.New("w_a_valid_backup_manifest_8905b1", ErrInvalidArchive)
	}
	r, err := m.Open()
	if err != nil {
		return manifest, i18n.New("w_w_f0fd7d", ErrInvalidArchive, err)
	}
	err = json.NewDecoder(io.LimitReader(r, 32<<20)).Decode(&manifest)
	if err != nil {
		err = i18n.New("w_w_f0fd7d", ErrInvalidArchive, err)
	}
	err = errors.Join(err, r.Close())
	if err != nil {
		return manifest, err
	}
	if manifest.Format != 1 || (manifest.Kind != "full" && manifest.Kind != "settings") || len(manifest.Entries) != len(entries)-1 {
		return manifest, i18n.New("w_invalid_backup_version_type_342220", ErrInvalidArchive)
	}
	var expanded int64
	for _, e := range manifest.Entries {
		if e.Size < 0 || e.Size > MaxExpandedBytes-expanded {
			return manifest, i18n.New("w_expanded_backup_exceeds_gib_8e4c5b", ErrInvalidArchive)
		}
		expanded += e.Size
	}
	var disk syscall.Statfs_t
	if err := syscall.Statfs(dest, &disk); err != nil {
		return manifest, err
	}
	if uint64(expanded)+(32<<20) > disk.Bavail*uint64(disk.Bsize) {
		return manifest, i18n.New("not_enough_disk_space_w_a39b20", syscall.ENOSPC)
	}
	seen := map[string]bool{}
	var total int64
	for _, e := range manifest.Entries {
		if err := ctx.Err(); err != nil {
			return manifest, err
		}
		f := entries[e.Path]
		if !validEntry(manifest.Kind, e.Path) || seen[e.Path] || f == nil || e.Size < 0 || e.Dir != f.FileInfo().IsDir() || uint64(e.Size) != f.UncompressedSize64 {
			return manifest, i18n.New("w_backup_manifest_does_not_69c8ba", ErrInvalidArchive)
		}
		seen[e.Path] = true
		total += e.Size
		if total > MaxExpandedBytes {
			return manifest, i18n.New("w_expanded_backup_exceeds_gib_8e4c5b", ErrInvalidArchive)
		}
		target := filepath.Join(dest, filepath.FromSlash(e.Path))
		if e.Dir {
			if e.Size != 0 {
				return manifest, i18n.New("w_invalid_directory_size_3ec5c4", ErrInvalidArchive)
			}
			if err := os.MkdirAll(target, 0700); err != nil {
				return manifest, err
			}
			continue
		}
		if len(e.SHA256) != 64 {
			return manifest, i18n.New("w_invalid_file_checksum_ec0b61", ErrInvalidArchive)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return manifest, err
		}
		in, err := f.Open()
		if err != nil {
			return manifest, i18n.New("w_w_f0fd7d", ErrInvalidArchive, err)
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			in.Close()
			return manifest, err
		}
		sum := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(out, sum), io.LimitReader(in, e.Size+1))
		var corruptDeflate flate.CorruptInputError
		if errors.Is(copyErr, zip.ErrChecksum) || errors.Is(copyErr, zip.ErrFormat) || errors.Is(copyErr, io.ErrUnexpectedEOF) || errors.As(copyErr, &corruptDeflate) {
			copyErr = i18n.New("w_w_f0fd7d", ErrInvalidArchive, copyErr)
		}
		err = errors.Join(copyErr, in.Close(), out.Close())
		if err != nil {
			return manifest, err
		}
		if n != e.Size || hex.EncodeToString(sum.Sum(nil)) != e.SHA256 {
			return manifest, i18n.New("w_file_verification_failed_s_46b024", ErrInvalidArchive, e.Path)
		}
		t := time.UnixMilli(e.Modified)
		if err := os.Chtimes(target, t, t); err != nil {
			return manifest, err
		}
	}
	if manifest.Kind == "full" && (!seen["app/rawmark.db"] || !seen["vault"] || entries["app/rawmark.db"].FileInfo().IsDir() || !entries["vault"].FileInfo().IsDir()) {
		return manifest, i18n.New("w_instance_backup_is_missing_4e260c", ErrInvalidArchive)
	}
	if manifest.Kind == "settings" && (!seen["settings.json"] || entries["settings.json"].FileInfo().IsDir()) {
		return manifest, i18n.New("w_settings_backup_is_missing_46056b", ErrInvalidArchive)
	}
	return manifest, nil
}
