//go:build !windows

package watch

import "os"

func snapshotInfo(path string) (os.FileInfo, error) { return os.Stat(path) }
