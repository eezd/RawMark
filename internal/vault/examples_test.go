package vault

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestSeedExamplesPreservesHierarchyAndAttachments(t *testing.T) {
	v := newVault(t)
	source := fstest.MapFS{
		"Guide/Welcome.md":       {Data: []byte("# Welcome\n\n![Example](./assets/image.png)\n")},
		"Guide/assets/image.png": {Data: []byte("example-image")},
	}
	if err := v.SeedExamples(source); err != nil {
		t.Fatal(err)
	}
	for name, original := range source {
		data, err := os.ReadFile(filepath.Join(v.Root(), filepath.FromSlash(name)))
		if err != nil || string(data) != string(original.Data) {
			t.Fatalf("example %s: %q, %v", name, data, err)
		}
	}
	if err := v.SeedExamples(fstest.MapFS{"Guide/Welcome.md": {Data: []byte("replacement")}}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(v.Root(), "Guide/Welcome.md"))
	if err != nil || string(data) != string(source["Guide/Welcome.md"].Data) {
		t.Fatalf("existing content changed: %q, %v", data, err)
	}
}

func TestSeedExamplesSkipsAnyExistingData(t *testing.T) {
	for _, name := range []string{"Personal.md", "empty-folder/", ".hidden", ".rawmark/tree-icons.json", ".rawmark/trash/deleted/note.md"} {
		t.Run(name, func(t *testing.T) {
			v := newVault(t)
			dest := filepath.Join(v.Root(), filepath.FromSlash(name))
			if strings.HasSuffix(name, "/") {
				if err := os.MkdirAll(dest, 0755); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(dest, []byte("private"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := v.SeedExamples(fstest.MapFS{"Example.md": {Data: []byte("public")}}); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(v.Root(), "Example.md")); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("examples were added to a used vault: %v", err)
			}
			if !strings.HasSuffix(name, "/") {
				data, err := os.ReadFile(dest)
				if err != nil || string(data) != "private" {
					t.Fatalf("existing content changed: %q, %v", data, err)
				}
			}
		})
	}
}

type unreadableExampleFS struct{ fs.FS }

func (f unreadableExampleFS) Open(name string) (fs.File, error) {
	if name == "Guide/Note.md" {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrPermission}
	}
	return f.FS.Open(name)
}

func TestSeedExamplesFailureDoesNotPublishPartialVault(t *testing.T) {
	v := newVault(t)
	source := unreadableExampleFS{fstest.MapFS{
		"First.md":      {Data: []byte("staged first")},
		"Guide/Note.md": {Data: []byte("unreadable")},
	}}
	if err := v.SeedExamples(source); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("original failure was lost: %v", err)
	}
	entries, err := os.ReadDir(v.Root())
	if err != nil || len(entries) != 1 || entries[0].Name() != metaDir {
		t.Fatalf("partial examples or temporary files remain: %v, %v", entries, err)
	}
	if err := v.SeedExamples(fstest.MapFS{"Welcome.md": {Data: []byte("retry")}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), "Welcome.md")); err != nil {
		t.Fatalf("retry failed: %v", err)
	}
}
