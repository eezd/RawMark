package api

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"rawmark/internal/auth"
	"rawmark/internal/events"
	"rawmark/internal/search"
	"rawmark/internal/store"
	"rawmark/internal/vault"
)

type fixture struct {
	server *Server
	t      *testing.T
	url    string
	root   string
	store  *store.Store
	hub    *events.Hub
	// Authenticated client.
	admin *http.Client
}

func TestNoteRevisionSurvivesProxyBoundary(t *testing.T) {
	f := newFixture(t)
	f.write("proxy.md", "original")
	res := f.do(f.admin, "GET", "/api/v1/files/proxy.md", "", nil)
	defer res.Body.Close()
	etag := res.Header.Get("ETag")
	if res.StatusCode != http.StatusOK || res.Header.Get("Cache-Control") != "no-store, no-transform" || !strings.HasPrefix(etag, `"`) {
		t.Fatalf("笔记响应必须保留强版本标识并禁止代理转换: %d %v", res.StatusCode, res.Header)
	}
	if code := f.status(f.admin, "PUT", "/api/v1/files/proxy.md", "updated", map[string]string{"If-Match": etag}); code != http.StatusOK {
		t.Fatalf("读取的版本标识应允许条件保存: %d", code)
	}
	if code := f.status(f.admin, "PUT", "/api/v1/files/proxy.md", "stale", map[string]string{"If-Match": etag}); code != http.StatusPreconditionFailed {
		t.Fatalf("过期版本必须仍拒绝保存: %d", code)
	}
}

func TestMoveBroadcastsWhenAssetRewriteReplacesFileIdentity(t *testing.T) {
	f := newFixture(t)
	f.write("from.md", "![](from.assets/x.png)")
	if err := os.Mkdir(filepath.Join(f.root, "from.assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	ch, cancel := f.hub.Subscribe()
	defer cancel()
	res := f.do(f.admin, "POST", "/api/v1/move", `{"from":"from.md","to":"to.md"}`, nil)
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("移动失败: %d", res.StatusCode)
	}
	select {
	case msg := <-ch:
		var batch []events.Event
		if err := json.Unmarshal(msg, &batch); err != nil {
			t.Fatal(err)
		}
		if len(batch) != 2 || batch[0].Type != "moved" || batch[0].From != "from.md" || batch[0].Path != "to.md" || batch[1].Type != "tree" {
			t.Fatalf("移动事件不符: %s", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("正文改写后未广播移动事件")
	}
}

func TestEventsRejectRevokedCredentials(t *testing.T) {
	for _, kind := range []string{"session", "token"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			client := newClient()
			headers := http.Header{}
			var tokenID string
			if kind == "session" {
				f.login(client, "password123").Body.Close()
			} else {
				created := decode[struct {
					Token string
					Info  store.APIToken
				}](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"events","scope":"read"}`, nil))
				headers.Set("Authorization", "Bearer "+created.Token)
				tokenID = created.Info.ID
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			conn, _, err := websocket.Dial(ctx, strings.Replace(f.url, "http://", "ws://", 1)+"/api/v1/events", &websocket.DialOptions{HTTPClient: client, HTTPHeader: headers})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			// The first event confirms subscription before testing authorization, avoiding handshake/broadcast timing races.
			f.hub.Broadcast(events.Event{Type: "tree"})
			if _, _, err := conn.Read(ctx); err != nil {
				t.Fatal(err)
			}
			if kind == "session" {
				f.do(client, "POST", "/api/v1/auth/logout", "", nil).Body.Close()
			} else {
				f.do(f.admin, "DELETE", "/api/v1/tokens/"+tokenID, "", nil).Body.Close()
			}
			f.hub.Broadcast(events.Event{Type: "changed", Path: "private.md", Rev: "new"})
			if _, _, err := conn.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
				t.Fatalf("撤销后应关闭连接，不能继续推送: %v", err)
			}
		})
	}
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
	am := auth.New(st)
	if err := am.Setup("password123"); err != nil {
		t.Fatal(err)
	}
	idx, err := search.Open(filepath.Join(dir, "index.db"), v)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { idx.Close() })
	hub := events.NewHub()
	server := New(v, am, st, hub, idx)
	server.DataDir = dir
	server.ThemesDir = filepath.Join(dir, "themes")
	server.PluginsDir = filepath.Join(dir, "plugins")
	server.FontsDir = filepath.Join(dir, "fonts")
	srv := httptest.NewServer(server.Handler(fstest.MapFS{}))
	t.Cleanup(srv.Close)
	f := &fixture{t: t, url: srv.URL, root: v.Root(), store: st, hub: hub, admin: newClient(), server: server}
	if res := f.login(f.admin, "password123"); res.StatusCode != 200 {
		t.Fatalf("登录失败: %d", res.StatusCode)
	}
	return f
}

type bearerTransport struct {
	mu    sync.Mutex
	token string
}

func (b *bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	b.mu.Lock()
	token := b.token
	b.mu.Unlock()
	if token != "" && r.Header.Get("Authorization") == "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	return http.DefaultTransport.RoundTrip(r)
}
func newClient() *http.Client { return &http.Client{Transport: &bearerTransport{}} }
func setClientToken(c *http.Client, token string) {
	b := c.Transport.(*bearerTransport)
	b.mu.Lock()
	b.token = token
	b.mu.Unlock()
}
func (f *fixture) login(c *http.Client, password string) *http.Response {
	challenge := decode[struct {
		CaptchaID string `json:"captchaId"`
	}](f.t, f.do(c, "POST", "/api/v1/auth/captcha", "{}", nil))
	f.server.captchas.mu.Lock()
	digits := f.server.captchas.challenges[challenge.CaptchaID].digits
	f.server.captchas.mu.Unlock()
	code := make([]byte, len(digits))
	for i, digit := range digits {
		code[i] = digit + '0'
	}
	body, _ := json.Marshal(map[string]string{"password": password, "captchaId": challenge.CaptchaID, "captchaCode": string(code)})
	res := f.do(c, "POST", "/api/v1/auth/login", string(body), nil)
	if res.StatusCode == 200 {
		content, _ := io.ReadAll(res.Body)
		res.Body.Close()
		res.Body = io.NopCloser(strings.NewReader(string(content)))
		var result struct{ Data struct{ Token string } }
		if err := json.Unmarshal(content, &result); err != nil {
			f.t.Fatal(err)
		}
		setClientToken(c, result.Data.Token)
	}
	return res
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
	var envelope struct {
		Code    int
		Data    T
		Message string
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Code != 0 {
		t.Fatalf("业务请求失败：HTTP %d，code=%d，message=%s", res.StatusCode, envelope.Code, envelope.Message)
	}
	return envelope.Data
}

// Documentation must match actual endpoints: missing new routes and obsolete documented routes both fail.
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

func TestAPIResponsesAreNotCached(t *testing.T) {
	f := newFixture(t)
	f.write("笔记.md", "# 正文")
	// Firefox once cached identity and tree responses offline, incorrectly opening an unloadable workspace.
	for _, path := range []string{"/api/v1/auth/state", "/api/v1/tree", "/api/v1/files/笔记.md", "/api/v1/raw/笔记.md"} {
		res := f.do(f.admin, "GET", path, "", nil)
		want := "no-store"
		if strings.HasPrefix(path, "/api/v1/files/") {
			want = "no-store, no-transform"
		}
		if res.StatusCode != http.StatusOK || res.Header.Get("Cache-Control") != want {
			t.Errorf("%s：状态 %d，缓存策略 %q", path, res.StatusCode, res.Header.Get("Cache-Control"))
		}
	}
}

func TestCompressedManifestContentType(t *testing.T) {
	body := strings.Repeat(" ", 300) + `{"name":"RawMark","display":"standalone"}`
	handler := newStaticHandler(fstest.MapFS{"manifest.webmanifest": {Data: []byte(body)}})
	req := httptest.NewRequest("GET", "/manifest.webmanifest", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	res := recorder.Result()
	defer res.Body.Close()
	if res.Header.Get("Content-Type") != "application/manifest+json" || res.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("清单响应头不正确：%v", res.Header)
	}
	zr, err := gzip.NewReader(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	var manifest map[string]string
	if err := json.NewDecoder(zr).Decode(&manifest); err != nil || manifest["name"] != "RawMark" {
		t.Fatalf("压缩清单无法解析：%v", err)
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

func TestSettingsMerge(t *testing.T) {
	f := newFixture(t)
	if got := decode[map[string]any](t, f.do(f.admin, "GET", "/api/v1/settings", "", nil)); len(got) != 0 {
		t.Fatalf("初始为空对象: %v", got)
	}
	f.do(f.admin, "PATCH", "/api/v1/settings", `{"fontSize":18,"theme":"dark"}`, nil)
	got := decode[map[string]any](t, f.do(f.admin, "PATCH", "/api/v1/settings", `{"fontSize":20,"theme":null,"cssSnippets":[{"id":"a"}]}`, nil))
	if got["fontSize"] != 20.0 || got["theme"] != nil || len(got["cssSnippets"].([]any)) != 1 {
		t.Fatalf("合并结果: %v", got)
	}
	if again := decode[map[string]any](t, f.do(f.admin, "GET", "/api/v1/settings", "", nil)); again["fontSize"] != 20.0 || len(again) != 2 {
		t.Fatalf("读取: %v", again)
	}
	for _, body := range []string{`[1]`, `null`, `"x"`, `{`} {
		if code := f.status(f.admin, "PATCH", "/api/v1/settings", body, nil); code != 400 {
			t.Errorf("%s 应为 400，得到 %d", body, code)
		}
	}
	tok := decode[struct{ Token string }](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"x","scope":"write"}`, nil)).Token
	bearer := map[string]string{"Authorization": "Bearer " + tok}
	if code := f.status(&http.Client{}, "GET", "/api/v1/settings", "", bearer); code != 200 {
		t.Errorf("令牌可读设置，得到 %d", code)
	}
	if code := f.status(&http.Client{}, "PATCH", "/api/v1/settings", `{"a":1}`, bearer); code != 403 {
		t.Errorf("令牌不能改设置（自定义 CSS 等会影响页面），得到 %d", code)
	}
}

func TestChangePassword(t *testing.T) {
	f := newFixture(t)
	other := newClient()
	f.login(other, "password123")
	if code := f.status(f.admin, "POST", "/api/v1/auth/password", `{"current":"wrong","next":"new-password"}`, nil); code != 400 {
		t.Errorf("当前密码错误应为 400，得到 %d", code)
	}
	if code := f.status(f.admin, "POST", "/api/v1/auth/password", `{"current":"password123","next":"short"}`, nil); code != 400 {
		t.Errorf("新密码过短应为 400，得到 %d", code)
	}
	if code := f.status(f.admin, "POST", "/api/v1/auth/password", `{"current":"password123","next":"new-password"}`, nil); code != 200 {
		t.Fatalf("修改密码: %d", code)
	}
	if code := f.status(f.admin, "GET", "/api/v1/tree", "", nil); code != 200 {
		t.Errorf("当前会话应保留，得到 %d", code)
	}
	if code := f.status(other, "GET", "/api/v1/tree", "", nil); code != 401 {
		t.Errorf("其他会话应失效，得到 %d", code)
	}
	if code := f.login(newClient(), "password123").StatusCode; code != 401 {
		t.Errorf("旧密码应失效，得到 %d", code)
	}
	if code := f.login(newClient(), "new-password").StatusCode; code != 200 {
		t.Errorf("新密码登录，得到 %d", code)
	}
}

func TestSetupWithoutCode(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "setup.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	server := New(nil, auth.New(st), st, nil, nil)
	srv := httptest.NewServer(server.Handler(fstest.MapFS{}))
	t.Cleanup(srv.Close)
	f := &fixture{t: t, url: srv.URL, server: server}
	owner := newClient()
	before := decode[struct{ SetUp, Authenticated bool }](t, f.do(owner, "GET", "/api/v1/auth/state", "", nil))
	if before.SetUp || before.Authenticated {
		t.Fatal("新实例不应已初始化或登录")
	}
	if status := f.status(owner, "POST", "/api/v1/auth/setup", `{"password":"short"}`, nil); status != 400 {
		t.Fatalf("弱密码应被拒绝: %d", status)
	}
	setup := f.do(owner, "POST", "/api/v1/auth/setup", `{"password":"password123"}`, nil)
	if status := setup.StatusCode; status != 200 {
		t.Fatalf("无需启动码即可初始化: %d", status)
	}
	setClientToken(owner, decode[struct{ Token string }](t, setup).Token)
	if res := f.do(owner, "GET", "/api/v1/auth/me", "", nil); res.StatusCode != 200 {
		t.Fatal("初始化未签发有效会话")
	}
	after := decode[struct{ SetUp, Authenticated bool }](t, f.do(owner, "GET", "/api/v1/auth/state", "", nil))
	if !after.SetUp {
		t.Fatal("初始化后应自动登录")
	}
	if status := f.status(newClient(), "POST", "/api/v1/auth/setup", `{"password":"replacement"}`, nil); status != 409 {
		t.Fatalf("重复初始化必须拒绝: %d", status)
	}
	// A new Manager simulates a restart and must not reopen password setup.
	reopened := auth.New(st)
	if err := reopened.Setup("replacement"); !errors.Is(err, auth.ErrAlreadySetUp) {
		t.Fatalf("重启后不能覆盖密码: %v", err)
	}
	if _, err := reopened.Login("test", "password123"); err != nil {
		t.Fatal("原密码应仍然有效", err)
	}
}

func TestConcurrentSetupCannotOverwritePassword(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "setup.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	manager := auth.New(st)
	server := New(nil, manager, st, nil, nil)
	srv := httptest.NewServer(server.Handler(fstest.MapFS{}))
	t.Cleanup(srv.Close)
	passwords := []string{"password-one", "password-two"}
	type outcome struct {
		index, status int
		err           error
	}
	results := make(chan outcome, 2)
	for index, password := range passwords {
		go func() {
			res, err := newClient().Post(srv.URL+"/api/v1/auth/setup", "application/json", strings.NewReader(`{"password":"`+password+`"}`))
			if err != nil {
				results <- outcome{index: index, err: err}
				return
			}
			res.Body.Close()
			results <- outcome{index: index, status: res.StatusCode}
		}()
	}
	winner, conflicts := -1, 0
	for range passwords {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		switch result.status {
		case 200:
			if winner >= 0 {
				t.Fatal("初始化成功不止一次")
			}
			winner = result.index
		case 409:
			conflicts++
		default:
			t.Fatalf("初始化状态不符: %d", result.status)
		}
	}
	if winner < 0 || conflicts != 1 {
		t.Fatal("必须只有一个初始化请求成功")
	}
	if _, err := manager.Login("test", passwords[winner]); err != nil {
		t.Fatal("成功请求的密码未保存", err)
	}
	if _, err := manager.Login("test", passwords[1-winner]); !errors.Is(err, auth.ErrBadCredentials) {
		t.Fatal("失败请求不应修改密码", err)
	}
}
