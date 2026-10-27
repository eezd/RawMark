// Package testutil provides real filesystem failure conditions for platform tests.
package testutil

import (
	"sync"
	"testing"

	"golang.org/x/sys/windows"
)

func denySharing(t *testing.T, name string, share uint32) func() {
	t.Helper()
	path, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(path, windows.GENERIC_READ, share, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatal(err)
	}
	release := sync.OnceFunc(func() {
		if err := windows.CloseHandle(handle); err != nil {
			t.Error(err)
		}
	})
	t.Cleanup(release)
	return release
}

func DenyRead(t *testing.T, name string) func() {
	t.Helper()
	path, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(path, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	release := sync.OnceFunc(func() {
		if err := windows.CloseHandle(handle); err != nil {
			t.Error(err)
		}
	})
	t.Cleanup(release)
	// A byte-range lock denies data reads while leaving directory enumeration and file attributes readable.
	var position windows.Overlapped
	if err := windows.LockFileEx(handle, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &position); err != nil {
		t.Fatal(err)
	}
	return release
}
func DenyReplace(t *testing.T, name string) func() {
	t.Helper()
	return denySharing(t, name, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE)
}
func DenyRemove(t *testing.T, directory string) func() {
	t.Helper()
	return denySharing(t, directory, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE)
}
