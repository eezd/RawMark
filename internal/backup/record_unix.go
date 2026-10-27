//go:build !windows

package backup

import (
	"errors"
	"os"
	"path/filepath"
)

func publishRecord(source, dest string) error {
	if err := os.Rename(source, dest); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(dest))
	if err != nil {
		return err
	}
	return errors.Join(dir.Sync(), dir.Close())
}
