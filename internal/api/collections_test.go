package api

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestCollectionShareFollowsEachSubjectAndKeepsItsScope(t *testing.T) {
	f := newFixture(t)
	f.write("私有/文章.md", "最新正文")
	f.write("私有/秘密.md", "不能公开")
	f.write("文件夹/内部.md", "内部正文")
	sh := decode[shareView](t, f.do(f.admin, "POST", "/api/v1/shares", `{"paths":["文件夹/内部.md","私有/文章.md","文件夹"]}`, nil))
	if len(sh.Items) != 2 || sh.Items[0].Path != "文件夹" {
		t.Fatalf("未消除重叠：%+v", sh)
	}
	base := "/api/v1/public/shares/" + sh.Token
	guest := newClient()
	root := decode[struct {
		Collection bool
		Items      []struct {
			ID     int
			Title  string
			Exists bool
		}
	}](t, f.do(guest, "GET", base, "", nil))
	if !root.Collection || len(root.Items) != 2 {
		t.Fatalf("集合首页不符：%+v", root)
	}
	for _, item := range root.Items {
		if strings.Contains(item.Title, "私有/") {
			t.Fatal("公开了主体的父目录")
		}
	}
	for _, endpoint := range []string{base + "?path=秘密.md", base + "?item=99", base + "?item=1&path=秘密.md", base + "/assets/../秘密.md?item=1", base + "/assets/秘密.md?item=1"} {
		response := f.do(guest, "GET", endpoint, "", nil)
		response.Body.Close()
		if response.StatusCode == http.StatusOK {
			t.Fatalf("越权访问成功：%s", endpoint)
		}
	}
	if code := f.status(f.admin, "POST", "/api/v1/move", `{"from":"私有/文章.md","to":"移动后.md"}`, nil); code != 200 {
		t.Fatalf("移动失败：%d", code)
	}
	content := decode[struct{ Content string }](t, f.do(guest, "GET", base+"?item=1", "", nil))
	if content.Content != "最新正文" {
		t.Fatalf("未跟随主体：%+v", content)
	}
	// 内部文件不是独立主体，移出文件夹后不能继续从该主体读取。
	f.do(f.admin, "POST", "/api/v1/move", `{"from":"文件夹/内部.md","to":"移出.md"}`, nil).Body.Close()
	if code := f.status(guest, "GET", base+"?item=0&path=内部.md", "", nil); code != 404 {
		t.Fatalf("移出后仍公开：%d", code)
	}
	f.do(f.admin, "DELETE", "/api/v1/files/移动后.md", "", nil).Body.Close()
	root = decode[struct {
		Collection bool
		Items      []struct {
			ID     int
			Title  string
			Exists bool
		}
	}](t, f.do(guest, "GET", base, "", nil))
	if !root.Items[0].Exists || root.Items[1].Exists {
		t.Fatalf("部分删除状态不符：%+v", root)
	}
	if code := f.status(guest, "GET", base+"?item=0", "", nil); code != 200 {
		t.Fatalf("部分删除影响其余主体：%d", code)
	}
}

func TestCollectionPasswordAssetsAndRevocation(t *testing.T) {
	f := newFixture(t)
	f.write("a.md", "文章")
	f.write("目录/b.md", "文章二")
	sh := decode[shareView](t, f.do(f.admin, "POST", "/api/v1/shares", `{"paths":["a.md","目录"],"password":"访问密码","expiresIn":86400}`, nil))
	base := "/api/v1/public/shares/" + sh.Token
	guest := newClient()
	if code := f.status(guest, "GET", base, "", nil); code != 401 {
		t.Fatal(code)
	}
	f.do(guest, "POST", base+"/unlock", `{"password":"访问密码"}`, nil).Body.Close()
	if code := f.status(guest, "GET", base+"?item=1&path=b.md", "", nil); code != 200 {
		t.Fatal(code)
	}
	if code := f.status(guest, "GET", base+"/assets/b.md?item=1", "", nil); code != 200 {
		t.Fatal(code)
	}
	f.do(f.admin, "DELETE", "/api/v1/shares/"+sh.Token, "", nil).Body.Close()
	if code := f.status(guest, "GET", fmt.Sprintf("%s?item=1", base), "", nil); code != 404 {
		t.Fatal(code)
	}
}
