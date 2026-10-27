package watch

import (
	"errors"
	"os"
)

func snapshotInfo(path string) (os.FileInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	// File.Stat captures the file ID from its open handle, before external renames.
	info, err := file.Stat()
	return info, errors.Join(err, file.Close())
}
