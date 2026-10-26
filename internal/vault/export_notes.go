package vault

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type MissingAsset struct {
	Note string `json:"note"`
	Path string `json:"path"`
}

// exclude comes from the application layer; the vault does not own database or resource-directory configuration.
func (v *Vault) ExportNotes(ctx context.Context, exclude func(string) bool) (result *os.File, err error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	f, err := os.CreateTemp("", "rawmark-notes-*.zip")
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			f.Close()
			os.Remove(f.Name())
		}
	}()
	z := zip.NewWriter(f)
	missing := []MissingAsset{}
	err = filepath.WalkDir(v.root, func(full string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if e = ctx.Err(); e != nil {
			return e
		}
		rel, e := filepath.Rel(v.root, full)
		if e != nil {
			return e
		}
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if full == f.Name() || (exclude != nil && exclude(rel)) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		for _, p := range strings.Split(rel, "/") {
			if strings.HasPrefix(p, ".") {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() && !info.IsDir() {
			return ErrInvalidPath
		}
		h, e := zip.FileInfoHeader(info)
		if e != nil {
			return e
		}
		h.Name = rel
		h.Method = zip.Deflate
		if d.IsDir() {
			h.Name += "/"
		}
		out, e := z.CreateHeader(h)
		if e != nil {
			return e
		}
		if d.IsDir() {
			return nil
		}
		in, e := os.Open(full)
		if e != nil {
			return e
		}
		_, e = io.Copy(out, in)
		e = errors.Join(e, in.Close())
		if e != nil {
			return e
		}
		if IsNote(rel) {
			content, _, e := v.Read(rel)
			if e != nil {
				return e
			}
			for _, target := range Analyze(rel, content).Assets {
				// Analyze resolves targets to vault-relative paths; inspect only local resources.
				if strings.HasPrefix(target.Target, "/") || strings.Contains(target.Target, "://") {
					continue
				}
				if _, e := v.Stat(target.Target); errors.Is(e, ErrNotFound) {
					missing = append(missing, MissingAsset{Note: rel, Path: target.Target})
				} else if e != nil {
					return e
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(missing) > 0 {
		// Keep the report in an internal directory to avoid collisions with user Markdown files; preserve original links.
		out, e := z.Create(path.Join(".rawmark-export", "missing-assets.json"))
		if e != nil {
			return nil, e
		}
		if err = json.NewEncoder(out).Encode(missing); err != nil {
			return nil, err
		}
	}
	if err = z.Close(); err != nil {
		return nil, err
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return f, nil
}
