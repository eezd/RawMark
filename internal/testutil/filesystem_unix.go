//go:build !windows

// Package testutil provides real filesystem failure conditions for platform tests.
package testutil

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func denyMode(t *testing.T, name string, mode os.FileMode) func() {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("Permission tests require an unprivileged user")
	}
	info, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(name, mode); err != nil {
		t.Fatal(err)
	}
	release := sync.OnceFunc(func() {
		if err := os.Chmod(name, info.Mode().Perm()); err != nil {
			t.Error(err)
		}
	})
	t.Cleanup(release)
	return release
}

func DenyRead(t *testing.T, name string) func() {
	t.Helper()
	return denyMode(t, name, 0)
}
func DenyReplace(t *testing.T, name string) func() {
	t.Helper()
	return denyMode(t, filepath.Dir(name), 0555)
}
func DenyRemove(t *testing.T, directory string) func() {
	t.Helper()
	return denyMode(t, directory, 0500)
}
