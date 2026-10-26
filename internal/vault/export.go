package vault

import (
	"archive/zip"
	"context"
	"html"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"rawmark/internal/i18n"
	"sort"
	"strings"
)

// Export builds an export in a temporary file; the caller must close and remove it after success.
// ZIP entries retain vault-relative paths and unchanged text. Export only source files; do not parse or download external resources.
func (v *Vault) Export(ctx context.Context, paths []string) (result *os.File, name string, err error) {
	if len(paths) == 0 {
		return nil, "", i18n.New("w_choose_content_to_export_170d5e", ErrInvalidPath)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	files := map[string]bool{}
	directory := false
	for _, p := range paths {
		info, e := v.Stat(p)
		if e != nil {
			return nil, "", e
		}
		if e = v.exportPath(p); e != nil {
			return nil, "", e
		}
		if !info.IsDir() {
			files[p] = false
			continue
		}
		directory = true
		files[p] = true
		entries, e := v.TreeAt(p)
		if e != nil {
			return nil, "", e
		}
		for _, entry := range entries {
			files[path.Join(p, entry.Path)] = entry.Dir
		}
	}
	// Collect attachments only for selected notes, without following links to other notes.
	notes := make([]string, 0)
	for p, dir := range files {
		if !dir && IsNote(p) {
			notes = append(notes, p)
		}
	}
	for _, note := range notes {
		if e := ctx.Err(); e != nil {
			return nil, "", e
		}
		content, _, e := v.Read(note)
		if e != nil {
			return nil, "", e
		}
		for _, span := range importLinkSpans(content) {
			target := string(content[span.start:span.end])
			if span.html {
				target = html.UnescapeString(target)
			} else {
				target = markdownEscape.ReplaceAllString(target, "$1")
			}
			u, e := url.Parse(target)
			if e != nil {
				return nil, "", i18n.New("w_invalid_attachment_address_s_8b6ace", ErrInvalidPath, target)
			}
			if u.IsAbs() || u.Host != "" || strings.HasPrefix(target, "/") || u.Path == "" {
				continue
			}
			rel := path.Clean(path.Join(path.Dir(note), u.Path))
			if IsNote(rel) {
				continue
			}
			if e = v.exportPath(rel); e != nil {
				return nil, "", i18n.New("attachment_s_w_7bc269", rel, e)
			}
			info, e := v.Stat(rel)
			if e != nil {
				return nil, "", i18n.New("attachment_s_w_7bc269", rel, e)
			}
			if !info.IsDir() {
				files[rel] = false
			}
		}
	}
	tmp, e := os.CreateTemp("", "rawmark-export-*")
	if e != nil {
		return nil, "", e
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	if len(paths) == 1 && !directory && len(files) == 1 && IsNote(paths[0]) {
		source, _, e := v.OpenRaw(paths[0])
		if e != nil {
			return nil, "", e
		}
		_, e = io.Copy(tmp, source)
		source.Close()
		if e != nil {
			return nil, "", e
		}
		name = path.Base(paths[0])
	} else {
		writer := zip.NewWriter(tmp)
		ordered := make([]string, 0, len(files))
		for p := range files {
			ordered = append(ordered, p)
		}
		sort.Strings(ordered)
		for _, p := range ordered {
			if e := ctx.Err(); e != nil {
				return nil, "", e
			}
			if e := v.exportPath(p); e != nil {
				return nil, "", e
			}
			if files[p] {
				if _, e := writer.Create(p + "/"); e != nil {
					return nil, "", e
				}
				continue
			}
			source, info, e := v.OpenRaw(p)
			if e != nil {
				return nil, "", e
			}
			header, e := zip.FileInfoHeader(info)
			if e != nil {
				source.Close()
				return nil, "", e
			}
			header.Name, header.Method = p, zip.Deflate
			dest, e := writer.CreateHeader(header)
			if e == nil {
				_, e = io.Copy(dest, source)
			}
			source.Close()
			if e != nil {
				return nil, "", e
			}
		}
		if e := writer.Close(); e != nil {
			return nil, "", e
		}
		name = "导出.zip"
		if len(paths) == 1 {
			name = strings.TrimSuffix(path.Base(paths[0]), NoteExt) + ".zip"
		}
	}
	if _, e := tmp.Seek(0, io.SeekStart); e != nil {
		return nil, "", e
	}
	return tmp, name, nil
}

// Attachments may use ../ to reference other folders, but cannot expose hidden paths or escape scope through symlinks.
func (v *Vault) exportPath(rel string) error {
	full, err := v.abs(rel)
	if err != nil {
		return err
	}
	real, err := filepath.EvalSymlinks(full)
	if os.IsNotExist(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if real != full {
		return ErrInvalidPath
	}
	return nil
}
