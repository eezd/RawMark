package vault

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unicode/utf8"
)

const (
	MaxImportBytes    = 100_000_000
	maxImportExpanded = 512 << 20
	maxImportEntries  = 10_000
	importNoteLimit   = 20 << 20
	importAssetLimit  = 50 << 20
)

var ErrInvalidImport = errors.New("导入内容无效")

// ImportFile 的读取范围是单个上传文件，ZIP 与普通 Markdown 共用这一输入边界。
type ImportFile struct {
	Name   string
	Reader io.ReaderAt
	Size   int64
}

type ImportResult struct {
	Paths    []string `json:"paths"`
	Notes    int      `json:"notes"`
	Assets   int      `json:"assets"`
	Warnings []string `json:"warnings"`
}

// Import 在隐藏目录内整理完整内容，提交前统一检查冲突，绝不覆盖已有文件。
func (v *Vault) Import(ctx context.Context, dir, folder string, files []ImportFile) (result ImportResult, err error) {
	result = ImportResult{Paths: []string{}, Warnings: []string{}}
	if len(files) == 0 || len(files) > maxImportEntries {
		return result, fmt.Errorf("%w：请选择 Markdown 文件或一个 ZIP", ErrInvalidImport)
	}
	zipped := len(files) == 1 && strings.EqualFold(path.Ext(files[0].Name), ".zip")
	if zipped {
		if _, err := CleanPath(folder); err != nil || strings.Contains(folder, "/") || strings.HasSuffix(folder, AssetsExt) {
			return result, fmt.Errorf("%w：导入文件夹名称无效", ErrInvalidImport)
		}
	} else if folder != "" {
		return result, fmt.Errorf("%w：普通 Markdown 不使用外层文件夹", ErrInvalidImport)
	}
	if dir != "" {
		if _, err := CleanPath(dir); err != nil {
			return result, err
		}
	}
	var uploadBytes int64
	for _, f := range files {
		if f.Size < 0 || f.Size > MaxImportBytes-uploadBytes {
			return result, ErrTooLarge
		}
		uploadBytes += f.Size
	}
	stage, err := os.MkdirTemp(v.root, tmpPrefix+"import-")
	if err != nil {
		return result, err
	}
	defer func() {
		if cleanup := os.RemoveAll(stage); cleanup != nil {
			err = errors.Join(err, fmt.Errorf("清理导入临时目录失败：%w", cleanup))
		}
	}()
	staged := &Vault{root: stage}
	entries := map[string]struct{}{}
	var total int64
	var notes []string
	// 每个来源文件只写一次；目录与文件重名也会在暂存阶段报错。
	write := func(name string, isDir bool, reader io.Reader) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := CleanPath(name); err != nil || !utf8.ValidString(name) {
			return fmt.Errorf("%w：ZIP 含有非法路径", ErrInvalidImport)
		}
		if _, exists := entries[name]; exists {
			return fmt.Errorf("%w：存在重复路径", ErrInvalidImport)
		}
		entries[name] = struct{}{}
		dest := filepath.Join(stage, filepath.FromSlash(name))
		if isDir {
			err := os.MkdirAll(dest, 0o755)
			if errors.Is(err, fs.ErrExist) || errors.Is(err, syscall.ENOTDIR) {
				return fmt.Errorf("%w：文件与目录路径冲突", ErrInvalidImport)
			}
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			if errors.Is(err, syscall.ENOTDIR) || errors.Is(err, fs.ErrExist) {
				return fmt.Errorf("%w：文件与目录路径冲突", ErrInvalidImport)
			}
			return err
		}
		f, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			if errors.Is(err, fs.ErrExist) || errors.Is(err, syscall.ENOTDIR) {
				return fmt.Errorf("%w：文件与目录路径冲突", ErrInvalidImport)
			}
			return err
		}
		limit := int64(importAssetLimit)
		if IsNote(name) {
			limit = importNoteLimit
			notes = append(notes, name)
		}
		limit = min(limit, maxImportExpanded-total)
		n, copyErr := io.Copy(f, io.LimitReader(reader, limit+1))
		closeErr := f.Close()
		total += n
		if n > limit {
			return ErrTooLarge
		}
		return errors.Join(copyErr, closeErr)
	}
	if zipped {
		z, err := zip.NewReader(files[0].Reader, files[0].Size)
		if err != nil {
			return result, fmt.Errorf("%w：无法读取 ZIP：%w", ErrInvalidImport, err)
		}
		if len(z.File) > maxImportEntries {
			return result, ErrTooLarge
		}
		for _, f := range z.File {
			if f.Name == ".rawmark-export/missing-assets.json" {
				continue
			} // 本程序笔记导出的缺失附件报告，不作为笔记导入。
			if !f.Mode().IsRegular() && !f.Mode().IsDir() {
				return result, fmt.Errorf("%w：ZIP 不允许符号链接或特殊文件", ErrInvalidImport)
			}
			name := strings.TrimSuffix(f.Name, "/")
			r, err := f.Open()
			if err != nil {
				return result, fmt.Errorf("%w：无法读取 ZIP 条目：%w", ErrInvalidImport, err)
			}
			err = write(name, f.FileInfo().IsDir(), r)
			err = errors.Join(err, r.Close())
			if err != nil {
				var corrupt flate.CorruptInputError
				if errors.Is(err, zip.ErrChecksum) || errors.Is(err, io.ErrUnexpectedEOF) || errors.As(err, &corrupt) {
					err = fmt.Errorf("%w：ZIP 内容损坏：%w", ErrInvalidImport, err)
				}
				return result, err
			}
		}
	} else {
		for _, f := range files {
			if !IsNote(f.Name) || strings.Contains(f.Name, "/") {
				return result, fmt.Errorf("%w：只接受 .md 文件或单个 ZIP", ErrInvalidImport)
			}
			if err := write(f.Name, false, io.NewSectionReader(f.Reader, 0, f.Size)); err != nil {
				return result, err
			}
		}
	}
	if len(notes) == 0 {
		return result, fmt.Errorf("%w：没有可导入的 Markdown 笔记", ErrInvalidImport)
	}
	sort.Strings(notes)
	migrated := map[string]bool{}
	for _, note := range notes {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		for _, seg := range strings.Split(path.Dir(note), "/") {
			if strings.HasSuffix(seg, AssetsExt) {
				return result, fmt.Errorf("%w：笔记不能放在 .assets 附件目录内", ErrInvalidImport)
			}
		}
		content, _, err := staged.Read(note)
		if err != nil {
			return result, err
		}
		if !utf8.Valid(content) || bytes.IndexByte(content, 0) >= 0 {
			return result, fmt.Errorf("%w：Markdown 必须是 UTF-8 文本", ErrInvalidImport)
		}
		content = bytes.TrimPrefix(content, []byte{0xef, 0xbb, 0xbf})
		updated, warnings, err := staged.importLinks(ctx, note, content, &total, migrated)
		if err != nil {
			return result, err
		}
		result.Warnings = append(result.Warnings, warnings...)
		if len(updated) > importNoteLimit || total+int64(len(updated)-len(content)) > maxImportExpanded {
			return result, ErrTooLarge
		}
		total += int64(len(updated) - len(content))
		if err := os.WriteFile(filepath.Join(stage, filepath.FromSlash(note)), updated, 0o644); err != nil {
			return result, err
		}
	}
	// 所有笔记改链完成后再清理已迁移的原图，避免后处理的笔记读取不到共享来源。
	if len(migrated) > 0 {
		used := map[string]bool{}
		for _, note := range notes {
			body, _, err := staged.Read(note)
			if err != nil {
				return result, err
			}
			metadata := Analyze(note, body)
			if len(metadata.Warnings) > 0 {
				return result, fmt.Errorf("%w：%s 的元数据异常，无法确认图片引用", ErrInvalidImport, note)
			}
			for _, ref := range metadata.Assets {
				used[ref.Target] = true
			}
		}
		for original := range migrated {
			if !used[original] {
				if err := os.Remove(filepath.Join(stage, filepath.FromSlash(original))); err != nil {
					return result, err
				}
			}
		}
	}
	result.Notes = len(notes)
	// 附件数量为最终保留的文件，包含目录共享图片与其他原始附件。
	count := 0
	err = filepath.WalkDir(stage, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		count++
		if count > maxImportEntries+1 {
			return ErrTooLarge
		}
		if !d.IsDir() && !IsNote(d.Name()) {
			result.Assets++
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	top, err := os.ReadDir(stage)
	if err != nil {
		return result, err
	}
	targets := []string{}
	if zipped {
		targets = append(targets, path.Join(dir, folder))
	} else {
		for _, f := range top {
			targets = append(targets, path.Join(dir, f.Name()))
		}
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	parent := v.root
	if dir != "" {
		parent, err = v.abs(dir)
		if err != nil {
			return result, err
		}
	}
	info, err := os.Stat(parent)
	if errors.Is(err, fs.ErrNotExist) {
		return result, ErrNotFound
	}
	if err != nil {
		return result, err
	}
	if !info.IsDir() {
		return result, fmt.Errorf("%w：目标不是文件夹", ErrInvalidImport)
	}
	for _, target := range targets {
		dest, err := v.abs(target)
		if err != nil {
			return result, err
		}
		if _, err := os.Lstat(dest); err == nil {
			return result, fmt.Errorf("%w：%s，请修改名称", ErrExists, target)
		} else if !errors.Is(err, fs.ErrNotExist) {
			return result, err
		}
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if zipped {
		// 暂存目录与仓库位于同一文件系统，整个 ZIP 一次 rename 发布。
		err = os.Rename(stage, filepath.Join(parent, folder))
	} else {
		var published []string
		for _, f := range top {
			name := f.Name()
			if err = os.Rename(filepath.Join(stage, name), filepath.Join(parent, name)); err != nil {
				for _, prev := range published {
					if rollback := os.Rename(filepath.Join(parent, prev), filepath.Join(stage, prev)); rollback != nil {
						err = errors.Join(err, fmt.Errorf("回滚导入失败：%w", rollback))
					}
				}
				break
			}
			published = append(published, name)
		}
	}
	if err != nil {
		return result, err
	}
	result.Paths = targets
	return result, nil
}
