package api

import (
	"archive/zip"
	"bytes"
	"testing"
)

func TestWindowsPluginPaths(t *testing.T) {
	if validPluginID("con") {
		t.Fatal("reserved Windows plugin ID accepted")
	}
	for _, name := range []string{"main.js.", "dir /module.js", "NUL.js", "module.js:stream"} {
		t.Run(name, func(t *testing.T) {
			var data bytes.Buffer
			archive := zip.NewWriter(&data)
			for _, entry := range []struct{ name, content string }{
				{"manifest.json", `{"id":"portable","name":"Portable","version":"1","apiVersion":1}`},
				{"main.js", "export default {}"},
				{name, "must not overwrite"},
			} {
				file, err := archive.Create(entry.name)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := file.Write([]byte(entry.content)); err != nil {
					t.Fatal(err)
				}
			}
			if err := archive.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := unpackPlugin(data.Bytes(), t.TempDir()); err == nil {
				t.Fatal("unsafe Windows archive path accepted")
			}
		})
	}
}
