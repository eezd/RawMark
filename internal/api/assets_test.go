package api

import (
	"io"
	"net/http"
	"rawmark/internal/vault"
	"testing"
)

func TestImageCleanupHonorsReferences(t *testing.T) {
	f := newFixture(t)
	f.write("assets/orphan.png", "orphan")
	f.write("assets/unused.png", "unused")
	f.write("assets/used.png", "used")
	f.write("note.md", "[image](assets/used.png)")
	if code := f.status(newClient(), "POST", "/api/v1/assets/cleanup", `{"paths":["assets/unused.png"]}`, nil); code != http.StatusUnauthorized {
		t.Fatal(code)
	}
	result := decode[vault.CleanupResult](t, f.do(f.admin, "POST", "/api/v1/assets/cleanup", `{"paths":["assets/orphan.png","assets/unused.png","assets/used.png"]}`, nil))
	if len(result.Deleted) != 2 || len(result.Skipped) != 1 || result.Skipped[0].Path != "assets/used.png" {
		t.Fatalf("引用保护不符：%+v", result)
	}
	if code := f.status(newClient(), "GET", "/api/v1/metadata", "", nil); code != http.StatusUnauthorized {
		t.Fatal(code)
	}
}

func TestImageCleanupRejectsDirectories(t *testing.T) {
	f := newFixture(t)
	f.write("assets/folder.png/keep.md", "保留目录内的笔记")
	f.write("assets/orphan.png", "image")
	res := f.do(f.admin, "POST", "/api/v1/assets/cleanup", `{"paths":["assets/folder.png","assets/orphan.png"]}`, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("清理应逐项汇报：%d", res.StatusCode)
	}
	result := decode[vault.CleanupResult](t, res)
	if len(result.Deleted) != 1 || result.Deleted[0].Path != "assets/orphan.png" || len(result.Skipped) != 1 || result.Skipped[0].Path != "assets/folder.png" || result.Skipped[0].Reason != "Not an image file" {
		t.Fatalf("目录应跳过，普通孤立图片仍可清理：%+v", result)
	}
	kept := f.do(f.admin, "GET", "/api/v1/files/assets/folder.png/keep.md", "", nil)
	if kept.StatusCode != http.StatusOK {
		t.Fatalf("目录内笔记被误移：%d", kept.StatusCode)
	}
	got, err := io.ReadAll(kept.Body)
	if err != nil || string(got) != "保留目录内的笔记" {
		t.Fatalf("目录内笔记内容被改变：%q %v", got, err)
	}
}
