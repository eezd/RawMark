package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"rawmark/deploy"
	"rawmark/internal/auth"
	"rawmark/internal/store"
	"rawmark/internal/vault"
	"testing"
)

func TestInitializeExamplesOnlyOnce(t *testing.T) {
	data := t.TempDir()
	v, err := vault.Open(filepath.Join(data, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(data, "rawmark.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := initializeExamples(v, st); err != nil {
		t.Fatal(err)
	}
	if ready, err := auth.New(st).IsSetUp(); err != nil || ready {
		t.Fatalf("examples must not initialize credentials: %v, %v", ready, err)
	}
	count := 0
	if err := fs.WalkDir(deploy.Examples, "data/vault", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if filepath.Ext(name) != ".md" {
			t.Fatalf("unexpected template file: %s", name)
		}
		count++
		rel, err := filepath.Rel("data/vault", name)
		if err != nil {
			return err
		}
		if _, err := os.Stat(filepath.Join(v.Root(), rel)); err != nil {
			return err
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if count != 7 {
		t.Fatalf("expected seven public sample notes, got %d", count)
	}
	// Deletion before password setup, settings reset, and process restart must not restore examples.
	entries, err := os.ReadDir(v.Root())
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != ".rawmark" {
			if err := os.RemoveAll(filepath.Join(v.Root(), entry.Name())); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := st.ResetPreferences(); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = store.Open(filepath.Join(data, "rawmark.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := initializeExamples(v, st); err != nil {
		t.Fatal(err)
	}
	entries, err = os.ReadDir(v.Root())
	if err != nil || len(entries) != 1 || entries[0].Name() != ".rawmark" {
		t.Fatalf("deleted examples were restored: %v, %v", entries, err)
	}
}

func TestInitializeExamplesSkipsInitializedEmptyInstance(t *testing.T) {
	data := t.TempDir()
	v, err := vault.Open(filepath.Join(data, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(data, "rawmark.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := auth.New(st).Setup("synthetic-test-password"); err != nil {
		t.Fatal(err)
	}
	if err := initializeExamples(v, st); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(v.Root())
	if err != nil || len(entries) != 1 || entries[0].Name() != ".rawmark" {
		t.Fatalf("examples were added to an existing account: %v, %v", entries, err)
	}
}
