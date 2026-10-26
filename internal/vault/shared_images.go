package vault

import (
	"os"
	"path"
	"path/filepath"
	"rawmark/internal/i18n"
	"strings"
)

type imageTransfer struct {
	source, target string
	data           []byte
	created        bool
	removeSource   bool
	removed        bool
}

// The caller holds the write lock and removes new copies if the subsequent note move fails.
// Move still carries legacy dedicated attachments with their directory; remove shared originals only when no other note references them.
func (v *Vault) copyNoteImages(from, to string) (transfers []imageTransfer, targets map[string]string, err error) {
	content, _, err := v.Read(from)
	if err != nil {
		return nil, nil, err
	}
	metadata := Analyze(from, content)
	if len(metadata.Warnings) != 0 {
		return nil, nil, i18n.New("w_invalid_metadata_in_s_cc1d10", ErrInvalidPath, from)
	}
	var images []Reference
	for _, ref := range metadata.Assets {
		if IsImage(ref.Target) && !strings.HasPrefix(ref.Target, AssetsDir(from)+"/") {
			images = append(images, ref)
		}
	}
	if len(images) == 0 {
		return nil, nil, nil
	}
	entries, err := v.Tree()
	if err != nil {
		return nil, nil, err
	}
	used := map[string]bool{}
	for _, entry := range entries {
		if entry.Dir || !IsNote(entry.Path) || entry.Path == from {
			continue
		}
		body, _, e := v.Read(entry.Path)
		if e != nil {
			return nil, nil, e
		}
		m := Analyze(entry.Path, body)
		if len(m.Warnings) != 0 {
			return nil, nil, i18n.New("w_invalid_metadata_in_s_cc1d10", ErrInvalidPath, entry.Path)
		}
		for _, ref := range m.Assets {
			used[ref.Target] = true
		}
	}
	targets = map[string]string{}
	for _, ref := range images {
		if _, seen := targets[ref.Target]; seen {
			continue
		}
		source, e := v.abs(ref.Target)
		if e != nil {
			return transfers, targets, e
		}
		info, e := os.Lstat(source)
		if os.IsNotExist(e) {
			continue // Retain links to already-missing images for the missing-resource report.
		}
		if e != nil {
			return transfers, targets, e
		}
		if !info.Mode().IsRegular() {
			return transfers, targets, ErrInvalidPath
		}
		data, e := os.ReadFile(source)
		if e != nil {
			return transfers, targets, e
		}
		dest, exists, e := v.assetDestination(path.Join(path.Dir(to), "assets"), path.Base(ref.Target), data)
		if e != nil {
			return transfers, targets, e
		}
		targets[ref.Target] = dest
		transfer := imageTransfer{source: ref.Target, target: dest, data: data, removeSource: !used[ref.Target] && ref.Target != dest}
		if !exists {
			full := filepath.Join(v.root, filepath.FromSlash(dest))
			if e := os.MkdirAll(filepath.Dir(full), 0o755); e != nil {
				return transfers, targets, e
			}
			if e := atomicWrite(full, data); e != nil {
				return transfers, targets, e
			}
			transfer.created = true
		}
		transfers = append(transfers, transfer)
	}
	return transfers, targets, nil
}
