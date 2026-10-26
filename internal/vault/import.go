package vault

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"rawmark/internal/i18n"
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

var ErrInvalidImport = i18n.New("invalid_import_contents_ed556a")

// ImportFile bounds reads to one uploaded file; ZIP and plain Markdown share this input boundary.
type ImportFile struct {
	Name   string
	Reader io.ReaderAt
	Size   int64
}

type ImportResult struct {
	Paths           []string      `json:"paths"`
	Notes           int           `json:"notes"`
	Assets          int           `json:"assets"`
	Warnings        []string      `json:"warnings"`
	WarningMessages []*i18n.Error `json:"-"`
}

// Import prepares complete contents in a hidden directory and checks all conflicts before commit, never overwriting existing files.
func (v *Vault) Import(ctx context.Context, dir, folder string, files []ImportFile) (result ImportResult, err error) {
	result = ImportResult{Paths: []string{}, Warnings: []string{}}
	if len(files) == 0 || len(files) > maxImportEntries {
		return result, i18n.New("w_choose_markdown_files_or_bcaa52", ErrInvalidImport)
	}
	zipped := len(files) == 1 && strings.EqualFold(path.Ext(files[0].Name), ".zip")
	if zipped {
		if _, err := CleanPath(folder); err != nil || strings.Contains(folder, "/") || strings.HasSuffix(folder, AssetsExt) {
			return result, i18n.New("w_invalid_import_folder_name_a10885", ErrInvalidImport)
		}
	} else if folder != "" {
		return result, i18n.New("w_plain_markdown_files_do_08b920", ErrInvalidImport)
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
			err = errors.Join(err, i18n.New("could_not_clean_the_temporary_212214", cleanup))
		}
	}()
	staged := &Vault{root: stage}
	entries := map[string]struct{}{}
	var total int64
	var notes []string
	// Write each source file once; file/directory name collisions also fail during staging.
	write := func(name string, isDir bool, reader io.Reader) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, err := CleanPath(name); err != nil || !utf8.ValidString(name) {
			return i18n.New("w_zip_contains_an_invalid_7bcf46", ErrInvalidImport)
		}
		if _, exists := entries[name]; exists {
			return i18n.New("w_duplicate_path_408694", ErrInvalidImport)
		}
		entries[name] = struct{}{}
		dest := filepath.Join(stage, filepath.FromSlash(name))
		if isDir {
			err := os.MkdirAll(dest, 0o755)
			if errors.Is(err, fs.ErrExist) || errors.Is(err, syscall.ENOTDIR) {
				return i18n.New("w_file_and_directory_paths_eb0b28", ErrInvalidImport)
			}
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			if errors.Is(err, syscall.ENOTDIR) || errors.Is(err, fs.ErrExist) {
				return i18n.New("w_file_and_directory_paths_eb0b28", ErrInvalidImport)
			}
			return err
		}
		f, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			if errors.Is(err, fs.ErrExist) || errors.Is(err, syscall.ENOTDIR) {
				return i18n.New("w_file_and_directory_paths_eb0b28", ErrInvalidImport)
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
			return result, i18n.New("w_could_not_read_zip_d4a777", ErrInvalidImport, err)
		}
		if len(z.File) > maxImportEntries {
			return result, ErrTooLarge
		}
		for _, f := range z.File {
			if f.Name == ".rawmark-export/missing-assets.json" {
				continue
			} // Do not import RawMark's missing-attachment export report as a note.
			if !f.Mode().IsRegular() && !f.Mode().IsDir() {
				return result, i18n.New("w_zip_cannot_contain_symlinks_5f596f", ErrInvalidImport)
			}
			name := strings.TrimSuffix(f.Name, "/")
			r, err := f.Open()
			if err != nil {
				return result, i18n.New("w_could_not_read_zip_8158b9", ErrInvalidImport, err)
			}
			err = write(name, f.FileInfo().IsDir(), r)
			err = errors.Join(err, r.Close())
			if err != nil {
				var corrupt flate.CorruptInputError
				if errors.Is(err, zip.ErrChecksum) || errors.Is(err, io.ErrUnexpectedEOF) || errors.As(err, &corrupt) {
					err = i18n.New("w_zip_content_is_damaged_6323c7", ErrInvalidImport, err)
				}
				return result, err
			}
		}
	} else {
		for _, f := range files {
			if !IsNote(f.Name) || strings.Contains(f.Name, "/") {
				return result, i18n.New("w_only_md_files_or_6f1a4f", ErrInvalidImport)
			}
			if err := write(f.Name, false, io.NewSectionReader(f.Reader, 0, f.Size)); err != nil {
				return result, err
			}
		}
	}
	if len(notes) == 0 {
		return result, i18n.New("w_no_importable_markdown_notes_3ad0b8", ErrInvalidImport)
	}
	sort.Strings(notes)
	migrated := map[string]bool{}
	for _, note := range notes {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		for _, seg := range strings.Split(path.Dir(note), "/") {
			if strings.HasSuffix(seg, AssetsExt) {
				return result, i18n.New("w_notes_cannot_be_inside_744972", ErrInvalidImport)
			}
		}
		content, _, err := staged.Read(note)
		if err != nil {
			return result, err
		}
		if !utf8.Valid(content) || bytes.IndexByte(content, 0) >= 0 {
			return result, i18n.New("w_markdown_must_be_utf_ce0d80", ErrInvalidImport)
		}
		content = bytes.TrimPrefix(content, []byte{0xef, 0xbb, 0xbf})
		updated, warnings, err := staged.importLinks(ctx, note, content, &total, migrated)
		if err != nil {
			return result, err
		}
		result.WarningMessages = append(result.WarningMessages, warnings...)
		for _, warning := range warnings {
			result.Warnings = append(result.Warnings, warning.Error())
		}
		if len(updated) > importNoteLimit || total+int64(len(updated)-len(content)) > maxImportExpanded {
			return result, ErrTooLarge
		}
		total += int64(len(updated) - len(content))
		if err := os.WriteFile(filepath.Join(stage, filepath.FromSlash(note)), updated, 0o644); err != nil {
			return result, err
		}
	}
	// Clean migrated source images only after rewriting all notes, so later notes can still read shared sources.
	if len(migrated) > 0 {
		used := map[string]bool{}
		for _, note := range notes {
			body, _, err := staged.Read(note)
			if err != nil {
				return result, err
			}
			metadata := Analyze(note, body)
			if len(metadata.Warnings) > 0 {
				return result, i18n.New("w_invalid_metadata_in_s_cc1d10", ErrInvalidImport, note)
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
	// The attachment count covers final retained files, including folder-shared images and other original attachments.
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
		return result, i18n.New("w_destination_is_not_a_f9de1c", ErrInvalidImport)
	}
	for _, target := range targets {
		dest, err := v.abs(target)
		if err != nil {
			return result, err
		}
		if _, err := os.Lstat(dest); err == nil {
			return result, i18n.New("w_s_choose_a_different_ac4d15", ErrExists, target)
		} else if !errors.Is(err, fs.ErrNotExist) {
			return result, err
		}
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if zipped {
		// Staging and the vault share a filesystem; publish the entire ZIP import with one rename.
		err = os.Rename(stage, filepath.Join(parent, folder))
	} else {
		var published []string
		for _, f := range top {
			name := f.Name()
			if err = os.Rename(filepath.Join(stage, name), filepath.Join(parent, name)); err != nil {
				for _, prev := range published {
					if rollback := os.Rename(filepath.Join(parent, prev), filepath.Join(stage, prev)); rollback != nil {
						err = errors.Join(err, i18n.New("import_rollback_failed_w_50748f", rollback))
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
