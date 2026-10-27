package fileutil

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestAvailableBytes(t *testing.T) {
	root := t.TempDir()
	available, err := AvailableBytes(root)
	if err != nil || available == 0 {
		t.Fatalf("available space: %d, %v", available, err)
	}
	if _, err := AvailableBytes(filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing directory accepted")
	}
}

func TestLocalPath(t *testing.T) {
	for _, name := range []string{"notes/中文 note.md", "vault/.rawmark/tree-icons.json", "vault/.rawmark/trash/id/meta.json"} {
		if !IsLocalPath(name) {
			t.Fatalf("valid path rejected: %s", name)
		}
	}
	for _, name := range []string{"", "../outside", "/absolute"} {
		if IsLocalPath(name) {
			t.Fatalf("nonlocal path accepted: %s", name)
		}
	}
	for _, name := range []string{"C:note.md", "note.md:stream", "CON", "a/NUL.txt", "a/note. ", "a/note.", "a?/note.md", "a/line\n.md"} {
		if got := IsLocalPath(name); got != (runtime.GOOS != "windows") {
			t.Fatalf("native path %q: %v", name, got)
		}
	}
}
