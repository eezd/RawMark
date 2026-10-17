package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"rawmark/internal/auth"
	"rawmark/internal/events"
	"rawmark/internal/search"
	"rawmark/internal/store"
	"rawmark/internal/vault"
)

type fixture struct {
	t     *testing.T
	url   string
	root  string
	store *store.Store
	// 已登录的客户端
	admin *http.Client
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	v, err := vault.Open(filepath.Join(dir, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "rawmark.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	am, err := auth.New(st)
	if err != nil {
		t.Fatal(err)
	}
	if err := am.Setup(am.SetupCode(), "password123"); err != nil {
		t.Fatal(err)
	}
	idx, err := search.Open(filepath.Join(dir, "index.db"), v)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { idx.Close() })
	srv := httptest.NewServer(New(v, am, st, events.NewHub(), idx).Handler(fstest.MapFS{}))
	t.Cleanup(srv.Close)
	f := &fixture{t: t, url: srv.URL, root: v.Root(), store: st, admin: newClient()}
	if res := f.do(f.admin, "POST", "/api/v1/auth/login", `{"password":"password123"}`, nil); res.StatusCode != 200 {
		t.Fatalf("登录失败: %d", res.StatusCode)
	}
	return f
}

func newClient() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar}
}

func (f *fixture) write(p, content string) {
	abs := filepath.Join(f.root, p)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) do(c *http.Client, method, path, body string, headers map[string]string) *http.Response {
	f.t.Helper()
	req, err := http.NewRequest(method, f.url+path, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { res.Body.Close() })
	return res
}

func (f *fixture) status(c *http.Client, method, path, body string, headers map[string]string) int {
	f.t.Helper()
	return f.do(c, method, path, body, headers).StatusCode
}

func decode[T any](t *testing.T, res *http.Response) T {
	t.Helper()
	var v T
	if err := json.NewDecoder(res.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// 文档与实际接口一一对应：新增接口忘记写文档、文档中残留已删除的接口都会失败
func TestOpenAPICoversRoutes(t *testing.T) {
	var spec struct {
		Paths map[string]map[string]json.RawMessage
	}
	if err := json.Unmarshal(openAPISpec, &spec); err != nil {
		t.Fatal(err)
	}
	documented := map[string]bool{}
	for p, ops := range spec.Paths {
		for method := range ops {
			if method != "parameters" {
				documented[strings.ToUpper(method)+" "+p] = true
			}
		}
	}
	wildcard := regexp.MustCompile(`\{(\w+)\.\.\.\}`)
	s := &Server{}
	for _, rt := range s.routes() {
		key := strings.Replace(wildcard.ReplaceAllString(rt.pattern, "{$1}"), " /api/v1", " ", 1)
		if !documented[key] {
			t.Errorf("接口未写入 openapi.json: %s", rt.pattern)
		}
		delete(documented, key)
	}
	for key := range documented {
		t.Errorf("openapi.json 中的接口不存在: %s", key)
	}
}

func TestShareAccess(t *testing.T) {
	f := newFixture(t)
	f.write("目录/笔记.md", "# 标题\n\n![](笔记.assets/图.png)\n")
	f.write("目录/笔记.assets/图.png", "PNG")
	f.write("目录/其他.png", "OTHER")
	f.write("目录/其他.assets/x.png", "X")

	res := f.do(f.admin, "POST", "/api/v1/shares", `{"path":"目录/笔记.md","password":"访问密码","expiresIn":0}`, nil)
	if res.StatusCode != 200 {
		t.Fatalf("创建分享: %d", res.StatusCode)
	}
	sh := decode[shareView](t, res)
	if !sh.HasPassword || !sh.Exists || sh.ExpiresAt != 0 || len(sh.Token) < 20 {
		t.Fatalf("分享信息: %+v", sh)
	}
	base := "/api/v1/public/shares/" + sh.Token
	guest := newClient()
	if code := f.status(guest, "GET", base, "", nil); code != 401 {
		t.Errorf("未输入密码应为 401，得到 %d", code)
	}
	if code := f.status(guest, "GET", base+"/assets/笔记.assets/图.png", "", nil); code != 401 {
		t.Errorf("未输入密码读图片应为 401，得到 %d", code)
	}
	if code := f.status(guest, "POST", base+"/unlock", `{"password":"错的"}`, nil); code != 401 {
		t.Errorf("错误密码应为 401，得到 %d", code)
	}
	if code := f.status(guest, "POST", base+"/unlock", `{"password":"访问密码"}`, nil); code != 200 {
		t.Fatalf("正确密码: %d", code)
	}
	got := decode[map[string]any](t, f.do(guest, "GET", base, "", nil))
	if got["title"] != "笔记" || got["content"] != "# 标题\n\n![](笔记.assets/图.png)\n" || got["path"] != nil {
		t.Errorf("分享内容: %v", got)
	}
	res = f.do(guest, "GET", base+"/assets/笔记.assets/图.png", "", nil)
	if b, _ := io.ReadAll(res.Body); res.StatusCode != 200 || string(b) != "PNG" {
		t.Errorf("本篇图片: %d %q", res.StatusCode, b)
	}
	for _, p := range []string{"其他.png", "笔记.assets/../其他.png", "其他.assets/x.png", "../目录/其他.png", "笔记.md"} {
		if code := f.status(guest, "GET", base+"/assets/"+p, "", nil); code != 404 {
			t.Errorf("图片目录之外的 %s 应为 404，得到 %d", p, code)
		}
	}

	// 改名后分享跟随
	if code := f.status(f.admin, "POST", "/api/v1/move", `{"from":"目录","to":"新目录"}`, nil); code != 200 {
		t.Fatalf("移动文件夹: %d", code)
	}
	if code := f.status(f.admin, "POST", "/api/v1/move", `{"from":"新目录/笔记.md","to":"新目录/改名.md"}`, nil); code != 200 {
		t.Fatalf("改名: %d", code)
	}
	got = decode[map[string]any](t, f.do(guest, "GET", base, "", nil))
	if got["title"] != "改名" || !strings.Contains(got["content"].(string), "改名.assets/") {
		t.Errorf("改名后分享内容: %v", got)
	}
	if code := f.status(guest, "GET", base+"/assets/改名.assets/图.png", "", nil); code != 200 {
		t.Errorf("改名后图片: %d", code)
	}

	// 其他分享的凭据不能用于本分享
	res = f.do(f.admin, "POST", "/api/v1/shares", `{"path":"新目录/其他.md"}`, nil)
	if res.StatusCode != 404 {
		t.Errorf("分享不存在的笔记应为 404，得到 %d", res.StatusCode)
	}
	f.write("新目录/其他.md", "其他")
	other := decode[shareView](t, f.do(f.admin, "POST", "/api/v1/shares", `{"path":"新目录/其他.md","password":"另一个"}`, nil))
	if code := f.status(guest, "GET", "/api/v1/public/shares/"+other.Token, "", nil); code != 401 {
		t.Errorf("凭据只对对应分享有效，得到 %d", code)
	}

	// 列表、删除笔记、撤销
	list := decode[struct{ Shares []shareView }](t, f.do(f.admin, "GET", "/api/v1/shares?path=新目录/改名.md", "", nil))
	if len(list.Shares) != 1 || list.Shares[0].Path != "新目录/改名.md" {
		t.Errorf("按笔记筛选: %+v", list.Shares)
	}
	if code := f.status(f.admin, "DELETE", "/api/v1/files/新目录/改名.md", "", nil); code != 200 {
		t.Fatal(code)
	}
	list = decode[struct{ Shares []shareView }](t, f.do(f.admin, "GET", "/api/v1/shares", "", nil))
	if len(list.Shares) != 2 || list.Shares[1].Exists {
		t.Errorf("笔记删除后分享标记为不存在: %+v", list.Shares)
	}
	if code := f.status(guest, "GET", base, "", nil); code != 404 {
		t.Errorf("笔记已删除应为 404，得到 %d", code)
	}
	if code := f.status(f.admin, "DELETE", "/api/v1/shares/"+sh.Token, "", nil); code != 200 {
		t.Fatal(code)
	}
	if code := f.status(guest, "POST", base+"/unlock", `{"password":"访问密码"}`, nil); code != 404 {
		t.Errorf("撤销后应为 404，得到 %d", code)
	}
	if code := f.status(newClient(), "GET", "/api/v1/shares", "", nil); code != 401 {
		t.Errorf("未登录不能管理分享，得到 %d", code)
	}
}

func TestShareWithoutPasswordAndExpiry(t *testing.T) {
	f := newFixture(t)
	f.write("a.md", "公开")
	sh := decode[shareView](t, f.do(f.admin, "POST", "/api/v1/shares", `{"path":"a.md","expiresIn":3600}`, nil))
	if sh.HasPassword || sh.ExpiresAt-time.Now().UnixMilli() < 3590_000 {
		t.Fatalf("分享信息: %+v", sh)
	}
	if code := f.status(newClient(), "GET", "/api/v1/public/shares/"+sh.Token, "", nil); code != 200 {
		t.Errorf("无密码分享直接可读，得到 %d", code)
	}
	if err := f.store.CreateShare(store.Share{Token: "expired", Path: "a.md", CreatedAt: 1, ExpiresAt: time.Now().Add(-time.Second).UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	if code := f.status(newClient(), "GET", "/api/v1/public/shares/expired", "", nil); code != 404 {
		t.Errorf("过期分享应为 404，得到 %d", code)
	}
	for _, body := range []string{`{"path":"a.assets/x.png"}`, `{"path":"../a.md"}`, `{"path":"a.md","expiresIn":-1}`} {
		if code := f.status(f.admin, "POST", "/api/v1/shares", body, nil); code != 400 {
			t.Errorf("%s 应为 400，得到 %d", body, code)
		}
	}
}

func TestAPITokenScopes(t *testing.T) {
	f := newFixture(t)
	f.write("a.md", "内容")
	create := func(scope string) string {
		res := f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"脚本","scope":"`+scope+`"}`, nil)
		if res.StatusCode != 200 {
			t.Fatalf("创建 %s 令牌: %d", scope, res.StatusCode)
		}
		return decode[struct{ Token string }](t, res).Token
	}
	read, write := create("read"), create("write")
	if code := f.status(f.admin, "POST", "/api/v1/tokens", `{"name":"x","scope":"admin"}`, nil); code != 400 {
		t.Errorf("无效范围应为 400，得到 %d", code)
	}
	bearer := func(tok string) map[string]string { return map[string]string{"Authorization": "Bearer " + tok} }
	anon := &http.Client{}
	cases := []struct {
		name, token, method, path, body string
		want                            int
	}{
		{"只读令牌可读", read, "GET", "/api/v1/files/a.md", "", 200},
		{"只读令牌可搜索", read, "GET", "/api/v1/tree", "", 200},
		{"只读令牌不能写", read, "PUT", "/api/v1/files/a.md", "改", 403},
		{"读写令牌可写", write, "PUT", "/api/v1/files/b.md", "新", 200},
		{"读写令牌也不能管理令牌", write, "GET", "/api/v1/tokens", "", 403},
		{"令牌不能管理分享", write, "POST", "/api/v1/shares", `{"path":"a.md"}`, 403},
		{"无效令牌", "rm_wrong", "GET", "/api/v1/tree", "", 401},
		{"格式不符的令牌", "abc", "GET", "/api/v1/tree", "", 401},
	}
	for _, c := range cases {
		if code := f.status(anon, c.method, c.path, c.body, bearer(c.token)); code != c.want {
			t.Errorf("%s: %d，期望 %d", c.name, code, c.want)
		}
	}

	list := decode[struct{ Tokens []store.APIToken }](t, f.do(f.admin, "GET", "/api/v1/tokens", "", nil))
	if len(list.Tokens) != 2 || list.Tokens[0].LastUsedAt == 0 {
		t.Fatalf("令牌列表（应记录使用时间）: %+v", list.Tokens)
	}
	raw, _ := io.ReadAll(f.do(f.admin, "GET", "/api/v1/tokens", "", nil).Body)
	if strings.Contains(string(raw), read) || strings.Contains(string(raw), "hash") {
		t.Errorf("列表不应包含令牌明文或哈希: %s", raw)
	}
	for _, tk := range list.Tokens {
		if code := f.status(f.admin, "DELETE", "/api/v1/tokens/"+tk.ID, "", nil); code != 200 {
			t.Fatal(code)
		}
	}
	if code := f.status(anon, "GET", "/api/v1/tree", "", bearer(read)); code != 401 {
		t.Errorf("吊销后应为 401，得到 %d", code)
	}
}
