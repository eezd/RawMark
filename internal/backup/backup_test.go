package backup

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rawmark/internal/auth"
	"rawmark/internal/store"
)

func writeTest(t *testing.T, file, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}
func database(t *testing.T, file string) {
	t.Helper()
	st, err := store.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	if err = auth.New(st).Setup("disposable-backup-password"); err != nil {
		t.Fatal(err)
	}
	if err = st.Close(); err != nil {
		t.Fatal(err)
	}
}
func fullArchive(t *testing.T, dir, content string) string {
	t.Helper()
	source := filepath.Join(dir, "source")
	os.MkdirAll(source, 0700)
	database(t, filepath.Join(source, "rawmark.db"))
	writeTest(t, filepath.Join(source, "vault/note.md"), content)
	archive := filepath.Join(dir, "backup.zip")
	if err := Create(context.Background(), archive, "full", []Source{{"app/rawmark.db", filepath.Join(source, "rawmark.db")}, {"vault", filepath.Join(source, "vault")}}, nil); err != nil {
		t.Fatal(err)
	}
	return archive
}
func TestRecoveryCommitAndRollback(t *testing.T) {
	for _, mode := range []string{"prepared", "applying", "invalid-source", "verifying"} {
		t.Run(mode, func(t *testing.T) {
			data := t.TempDir()
			vault := filepath.Join(data, "vault")
			oldArchive := fullArchive(t, t.TempDir(), "old")
			oldStage := t.TempDir()
			if _, err := Extract(context.Background(), oldArchive, oldStage); err != nil {
				t.Fatal(err)
			}
			if err := CopyTree(filepath.Join(oldStage, "app"), data); err != nil {
				t.Fatal(err)
			}
			if err := CopyTree(filepath.Join(oldStage, "vault"), vault); err != nil {
				t.Fatal(err)
			}
			os.MkdirAll(filepath.Join(data, "backups"), 0700)
			saved := filepath.Join(data, "backups/old.zip")
			if err := copyFile(oldArchive, saved, 0600); err != nil {
				t.Fatal(err)
			}
			upload := filepath.Join(data, ".maintenance/uploads/test/stage")
			os.MkdirAll(upload, 0700)
			newArchive := fullArchive(t, t.TempDir(), "new")
			if _, err := Extract(context.Background(), newArchive, upload); err != nil {
				t.Fatal(err)
			}
			state := mode
			if mode == "invalid-source" {
				state = "prepared"
				writeTest(t, filepath.Join(upload, "app/rawmark.db"), "invalid SQLite")
			}
			if mode == "applying" || mode == "verifying" {
				writeTest(t, filepath.Join(vault, "note.md"), "partial")
			}
			if err := WriteRecord(data, RestoreRecord{State: state, Stage: upload, Backup: saved}); err != nil {
				t.Fatal(err)
			}
			err := Recover(data, vault)
			expected := "old"
			if mode == "prepared" {
				if err != nil {
					t.Fatal(err)
				}
				if pending, _ := Pending(data); !pending {
					t.Fatal("验证启动前不应提交")
				}
				if err = FinishRecovery(data); err != nil {
					t.Fatal(err)
				}
				expected = "new"
			} else if err == nil {
				t.Fatal("回退应保留失败原因")
			}
			body, err := os.ReadFile(filepath.Join(vault, "note.md"))
			if err != nil || string(body) != expected {
				t.Fatalf("恢复内容错误: %q %v", body, err)
			}
			if pending, err := Pending(data); err != nil || pending {
				t.Fatalf("回退或提交后仍有记录: %v", err)
			}
			if err = CheckDatabase(filepath.Join(data, "rawmark.db")); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestArchiveRejectsTraversalDuplicateLinksAndCorruption(t *testing.T) {
	for _, mode := range []string{"traversal", "duplicate", "symlink", "checksum"} {
		t.Run(mode, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "invalid.zip")
			f, _ := os.Create(file)
			z := zip.NewWriter(f)
			switch mode {
			case "traversal":
				out, _ := z.Create("../outside")
				out.Write([]byte("bad"))
			case "duplicate":
				z.Create("settings.json")
				z.Create("settings.json")
			case "symlink":
				header := &zip.FileHeader{Name: "app/fonts/link"}
				header.SetMode(os.ModeSymlink | 0777)
				out, _ := z.CreateHeader(header)
				out.Write([]byte("/etc/passwd"))
			case "checksum":
				out, _ := z.Create("settings.json")
				out.Write([]byte("{}"))
				manifest, _ := z.Create("manifest.json")
				io.WriteString(manifest, `{"format":1,"kind":"settings","entries":[{"path":"settings.json","size":2,"sha256":"`+strings.Repeat("0", 64)+`"}]}`)
			}
			z.Close()
			f.Close()
			if _, err := Extract(context.Background(), file, t.TempDir()); err == nil {
				t.Fatal("无效归档被接受")
			}
		})
	}
}
func TestSettingsInterruptedImportRestoresPreferencesAndResources(t *testing.T) {
	data := t.TempDir()
	database(t, filepath.Join(data, "rawmark.db"))
	st, _ := store.OpenExisting(filepath.Join(data, "rawmark.db"))
	st.SetSetting("app.settings", `{"fontSize":18}`)
	source := t.TempDir()
	writeTest(t, filepath.Join(source, "settings.json"), `{"app.settings":{"fontSize":18},"plugin.data.example":{"content":"old"}}`)
	writeTest(t, filepath.Join(source, "fonts/original/font.woff2"), "old-font")
	os.MkdirAll(filepath.Join(data, "backups"), 0700)
	archive := filepath.Join(data, "backups/settings.zip")
	if err := Create(context.Background(), archive, "settings", []Source{{"settings.json", filepath.Join(source, "settings.json")}, {"app/fonts", filepath.Join(source, "fonts")}}, nil); err != nil {
		t.Fatal(err)
	}
	st.SetSetting("app.settings", `{"fontSize":24}`)
	st.Close()
	writeTest(t, filepath.Join(data, "fonts/new/font.woff2"), "new-font")
	stage := filepath.Join(data, ".maintenance/uploads/test/stage")
	os.MkdirAll(stage, 0700)
	if err := WriteRecord(data, RestoreRecord{State: "applying", Kind: "settings", Stage: stage, Backup: archive}); err != nil {
		t.Fatal(err)
	}
	if err := Recover(data, filepath.Join(data, "vault")); err == nil {
		t.Fatal("应报告中断并回退")
	}
	st, _ = store.OpenExisting(filepath.Join(data, "rawmark.db"))
	defer st.Close()
	value, _, err := st.Setting("app.settings")
	if err != nil || value != `{"fontSize":18}` {
		t.Fatal("偏好未回退")
	}
	if body, err := os.ReadFile(filepath.Join(data, "fonts/original/font.woff2")); err != nil || string(body) != "old-font" {
		t.Fatal("资源未回退")
	}
	if _, err := os.Stat(filepath.Join(data, "fonts/new")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("残留新资源")
	}
}
func TestLogRotationIsBounded(t *testing.T) {
	dir := t.TempDir()
	log, err := OpenLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	chunk := []byte(strings.Repeat("a", 6<<20))
	for i := 0; i < 5; i++ {
		if _, err = log.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	dest := t.TempDir()
	if err = log.Snapshot(dest); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 3 {
		t.Fatalf("轮转文件数错误: %d", len(entries))
	}
	for _, entry := range entries {
		info, _ := entry.Info()
		if info.Size() > 10<<20 || info.Mode().Perm() != 0600 {
			t.Fatalf("日志未限量或权限不符: %+v", info)
		}
	}
}
