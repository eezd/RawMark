package backup

import (
	"archive/zip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRejectWindowsArchivePaths(t *testing.T) {
	for _, name := range []string{"C:escape", "vault/note.md:stream", "vault/CON", "vault/dir./note.md"} {
		t.Run(name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "invalid.zip")
			f, err := os.Create(file)
			if err != nil {
				t.Fatal(err)
			}
			z := zip.NewWriter(f)
			if _, err := z.Create(name); err != nil {
				t.Fatal(err)
			}
			if err := errors.Join(z.Close(), f.Close()); err != nil {
				t.Fatal(err)
			}
			if _, err := Extract(context.Background(), file, t.TempDir()); !errors.Is(err, ErrInvalidArchive) {
				t.Fatalf("unsafe archive path accepted: %v", err)
			}
		})
	}
}
