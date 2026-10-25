package api

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"rawmark/internal/auth"
	"rawmark/internal/events"
	"rawmark/internal/search"
	"rawmark/internal/store"
	"rawmark/internal/vault"
)

func TestPortableNotesExcludeApplicationData(t *testing.T) {
	for _, layout := range []string{"default", "same-root", "nested-app", "symlink-data"} {
		t.Run(layout, func(t *testing.T) {
			root := t.TempDir()
			data := root
			switch layout {
			case "default":
				root = filepath.Join(data, "vault")
			case "nested-app", "symlink-data":
				data = filepath.Join(root, "application")
			}
			if err := os.MkdirAll(data, 0700); err != nil {
				t.Fatal(err)
			}
			if layout == "symlink-data" {
				link := filepath.Join(t.TempDir(), "data")
				if err := os.Symlink(data, link); err != nil {
					t.Fatal(err)
				}
				data = link
			}
			v, err := vault.Open(root)
			if err != nil {
				t.Fatal(err)
			}
			st, err := store.Open(filepath.Join(data, "rawmark.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			am := auth.New(st)
			if err = am.Setup("disposable-export-password"); err != nil {
				t.Fatal(err)
			}
			idx, err := search.Open(filepath.Join(data, "index.db"), v)
			if err != nil {
				t.Fatal(err)
			}
			defer idx.Close()
			server := New(v, am, st, events.NewHub(), idx)
			server.DataDir = data
			srv := httptest.NewServer(server.Handler(fstest.MapFS{}))
			defer srv.Close()
			f := &fixture{t: t, url: srv.URL, root: root, store: st, admin: newClient(), server: server}
			res := f.login(f.admin, "disposable-export-password")
			assertOK(t, res)
			res.Body.Close()
			f.write("note.md", "# portable note\n![](assets/a.png)")
			f.write("assets/a.png", "image")
			f.write("personal/fonts/keep.dat", "user resource")
			for _, name := range []string{"temp", "backups", "logs", "fonts", "themes", "plugins"} {
				dir := filepath.Join(data, name)
				if err = os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(filepath.Join(dir, "application.dat"), []byte("private"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			// 与真实进程一致，导出暂存文件位于应用数据目录内。
			t.Setenv("TMPDIR", filepath.Join(data, "temp"))
			res = f.do(f.admin, "POST", "/api/v1/maintenance/notes/export", "", nil)
			defer res.Body.Close()
			assertOK(t, res)
			body, err := io.ReadAll(res.Body)
			if err != nil {
				t.Fatal(err)
			}
			z, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]string{"note.md": "# portable note\n![](assets/a.png)", "assets/a.png": "image", "personal/fonts/keep.dat": "user resource"}
			for _, file := range z.File {
				if file.FileInfo().IsDir() {
					continue
				}
				expected, ok := want[file.Name]
				if !ok {
					t.Fatalf("笔记导出包含应用数据或临时文件：%s", file.Name)
				}
				r, err := file.Open()
				if err != nil {
					t.Fatal(err)
				}
				content, err := io.ReadAll(r)
				r.Close()
				if err != nil || string(content) != expected {
					t.Fatalf("笔记或附件内容改变：%s，%v", file.Name, err)
				}
				delete(want, file.Name)
			}
			if len(want) != 0 {
				t.Fatalf("遗漏用户文件：%v", want)
			}
		})
	}
}
