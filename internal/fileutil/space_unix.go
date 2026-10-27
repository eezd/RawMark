//go:build !windows

package fileutil

import "syscall"

// AvailableBytes returns disk space available to the current user.
func AvailableBytes(dir string) (uint64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(dir, &stat); err != nil {
		return 0, err
	}
	return stat.Bavail * uint64(stat.Bsize), nil
}
