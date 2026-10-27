package vault

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// SeedExamples populates only a completely unused vault, before the watcher starts.
// Existing folders, hidden files, icons, or recycled notes count as user data.
func (v *Vault) SeedExamples(examples fs.FS) (err error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	entries, err := os.ReadDir(v.root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != metaDir || !entry.IsDir() {
			return nil
		}
	}
	metadata, err := os.ReadDir(filepath.Join(v.root, metaDir))
	if err != nil {
		return err
	}
	for _, entry := range metadata {
		if entry.Name() != "trash" || !entry.IsDir() {
			return nil
		}
	}
	trash, err := os.ReadDir(v.trash)
	if err != nil || len(trash) != 0 {
		return err
	}

	stage, err := os.MkdirTemp(v.root, tmpPrefix+"examples-")
	if err != nil {
		return err
	}
	cleanup := true
	defer func() {
		if cleanup {
			err = errors.Join(err, os.RemoveAll(stage))
		}
	}()
	if err = os.CopyFS(stage, examples); err != nil {
		return err
	}
	entries, err = os.ReadDir(stage)
	if err != nil {
		return err
	}
	var published []string
	for _, entry := range entries {
		name := entry.Name()
		if err = os.Rename(filepath.Join(stage, name), filepath.Join(v.root, name)); err != nil {
			for _, previous := range published {
				if rollback := os.Rename(filepath.Join(v.root, previous), filepath.Join(stage, previous)); rollback != nil {
					// Preserve the staging directory if it contains the only copy of any files.
					cleanup = false
					err = errors.Join(err, rollback)
				}
			}
			return err
		}
		published = append(published, name)
	}
	return nil
}
