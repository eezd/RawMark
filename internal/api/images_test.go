package api

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
)

func TestUploadsReturnSharedRelativeLinks(t *testing.T) {
	f := newFixture(t)
	f.write("notes/a.md", "正文")
	f.write("notes/b.md", "正文")
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "image.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(file, "image"); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	var previous string
	for _, query := range []string{"note=notes/a.md", "note=notes/b.md", "folder=notes"} {
		result := decode[struct{ Link string }](t, f.do(f.admin, "POST", "/api/v1/assets?"+query, body.String(), map[string]string{"Content-Type": form.FormDataContentType()}))
		if !strings.HasPrefix(result.Link, "./assets/") || (previous != "" && previous != result.Link) {
			t.Fatalf("上传链接或共享去重不符：%s", result.Link)
		}
		previous = result.Link
		res := f.do(f.admin, "GET", "/api/v1/raw/notes/"+strings.TrimPrefix(result.Link, "./"), "", nil)
		data, err := io.ReadAll(res.Body)
		if res.StatusCode != 200 || err != nil || string(data) != "image" {
			t.Fatalf("返回链接不能读取原图：%d %q %v", res.StatusCode, data, err)
		}
	}
}

func TestReplaceImageAPI(t *testing.T) {
	f := newFixture(t)
	f.write("assets/a.png", "original")
	f.write("a.md", "![](assets/a.png)")
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "replacement.png")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(file, "replacement"); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	headers := map[string]string{"Content-Type": form.FormDataContentType()}
	if code := f.status(newClient(), "PUT", "/api/v1/assets/assets/a.png", body.String(), headers); code != 401 {
		t.Fatalf("未登录应被拒绝：%d", code)
	}
	readToken := decode[struct{ Token string }](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"read","scope":"read"}`, nil)).Token
	if code := f.status(newClient(), "PUT", "/api/v1/assets/assets/a.png", body.String(), map[string]string{"Content-Type": form.FormDataContentType(), "Authorization": "Bearer " + readToken}); code != 403 {
		t.Fatalf("只读令牌不能替换图片：%d", code)
	}
	for route, want := range map[string]int{"/api/v1/assets/assets/a.png": 200, "/api/v1/assets/missing.png": 404, "/api/v1/assets/a.md": 400} {
		if code := f.status(f.admin, "PUT", route, body.String(), headers); code != want {
			t.Fatalf("%s：得到 %d，期望 %d", route, code, want)
		}
	}
	res := f.do(f.admin, "GET", "/api/v1/raw/assets/a.png", "", nil)
	data, err := io.ReadAll(res.Body)
	if err != nil || string(data) != "replacement" || res.Header.Get("Content-Security-Policy") == "" || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("替换内容或安全边界错误：%q %v", data, err)
	}
	note := f.do(f.admin, "GET", "/api/v1/files/a.md", "", nil)
	data, err = io.ReadAll(note.Body)
	if err != nil || string(data) != "![](assets/a.png)" {
		t.Fatalf("替换不应改变引用：%q %v", data, err)
	}
	// 复用现有移动与回收站接口，图片不会被当作 Markdown 正文读取。
	if code := f.status(f.admin, "POST", "/api/v1/move", `{"from":"assets/a.png","to":"assets/b.png"}`, nil); code != 200 {
		t.Fatal(code)
	}
	deleted := decode[struct{ ID string }](t, f.do(f.admin, "DELETE", "/api/v1/files/assets/b.png", "", nil))
	if code := f.status(f.admin, "POST", "/api/v1/trash/"+deleted.ID+"/restore", "", nil); code != http.StatusOK {
		t.Fatal(code)
	}
}
