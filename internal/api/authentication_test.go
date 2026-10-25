package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func challengeFor(t *testing.T, f *fixture) (string, string) {
	t.Helper()
	item := decode[struct{ CaptchaID, ImageDataURL string }](t, f.do(newClient(), "POST", "/api/v1/auth/captcha", "{}", nil))
	png, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(item.ImageDataURL, "data:image/png;base64,"))
	if err != nil || !bytes.HasPrefix(png, []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		t.Fatal("未返回真实PNG验证码")
	}
	f.server.captchas.mu.Lock()
	digits := append([]byte(nil), f.server.captchas.challenges[item.CaptchaID].digits...)
	f.server.captchas.mu.Unlock()
	for i := range digits {
		digits[i] += '0'
	}
	return item.CaptchaID, string(digits)
}
func loginBody(id, code, password string) string {
	body, _ := json.Marshal(map[string]string{"captchaId": id, "captchaCode": code, "password": password})
	return string(body)
}
func TestCaptchaLoginLifecycle(t *testing.T) {
	f := newFixture(t)
	c := newClient()
	if res := f.do(c, "POST", "/api/v1/auth/login", `{"password":"password123"}`, nil); res.StatusCode != 400 {
		t.Fatal("缺失验证码未拒绝")
	}
	id, code := challengeFor(t, f)
	bad := loginBody(id, "invalid", "password123")
	if res := f.do(c, "POST", "/api/v1/auth/login", bad, nil); res.StatusCode != 400 {
		t.Fatal("错误验证码未拒绝")
	}
	if res := f.do(c, "POST", "/api/v1/auth/login", loginBody(id, code, "password123"), nil); res.StatusCode != 400 {
		t.Fatal("错误提交后挑战仍可复用")
	}
	id, code = challengeFor(t, f)
	if res := f.do(c, "POST", "/api/v1/auth/login", loginBody(id, code, "wrong"), nil); res.StatusCode != 401 {
		t.Fatal("密码错误状态不符")
	}
	if res := f.do(c, "POST", "/api/v1/auth/login", loginBody(id, code, "password123"), nil); res.StatusCode != 400 {
		t.Fatal("密码失败后挑战仍可复用")
	}
	id, code = challengeFor(t, f)
	f.server.captchas.mu.Lock()
	item := f.server.captchas.challenges[id]
	item.expires = time.Now().Add(-time.Second)
	f.server.captchas.challenges[id] = item
	f.server.captchas.mu.Unlock()
	expired := f.do(c, "POST", "/api/v1/auth/login", loginBody(id, code, "password123"), nil)
	var failure response
	if err := json.NewDecoder(expired.Body).Decode(&failure); err != nil || expired.StatusCode != 400 || failure.Code != CodeCaptchaExpired {
		t.Fatal("未区分过期挑战")
	}
	id, code = challengeFor(t, f)
	refreshed := f.do(c, "POST", "/api/v1/auth/captcha", `{"replaceId":"`+id+`"}`, nil)
	if refreshed.StatusCode != 200 {
		t.Fatal("刷新失败")
	}
	if res := f.do(c, "POST", "/api/v1/auth/login", loginBody(id, code, "password123"), nil); res.StatusCode != 400 {
		t.Fatal("刷新后旧挑战仍有效")
	}
	id, code = challengeFor(t, f)
	good := f.do(c, "POST", "/api/v1/auth/login", loginBody(id, code, "password123"), nil)
	data := decode[struct {
		Token     string
		ExpiresAt time.Time
	}](t, good)
	if good.StatusCode != 200 || !strings.HasPrefix(data.Token, "rms_") || time.Until(data.ExpiresAt) < 29*24*time.Hour || len(good.Cookies()) != 0 {
		t.Fatal("未返回固定有效期Bearer会话")
	}
	setClientToken(c, data.Token)
	if f.status(c, "GET", "/api/v1/auth/me", "", nil) != 200 {
		t.Fatal("身份恢复失败")
	}

	req, _ := http.NewRequest("GET", f.url+"/api/v1/tree", nil)
	req.AddCookie(&http.Cookie{Name: "rawmark_session", Value: data.Token})
	cookieRes, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer cookieRes.Body.Close()
	if cookieRes.StatusCode != 401 {
		t.Fatal("旧Cookie仍被接受")
	}
	if f.status(c, "POST", "/api/v1/auth/logout", "", nil) != 204 || f.status(c, "GET", "/api/v1/tree", "", nil) != 401 {
		t.Fatal("服务端未撤销会话")
	}
}

func TestCaptchaSingleConsumptionAndLimits(t *testing.T) {
	c := newCaptchas()
	clock := time.Now()
	c.now = func() time.Time { return clock }
	id, item, err := c.create("source", "")
	if err != nil {
		t.Fatal(err)
	}
	digits := append([]byte(nil), item.digits...)
	for i := range digits {
		digits[i] += '0'
	}
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); results <- c.consume("source", id, string(digits)) }()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatal("挑战被重复消费")
	}
	for range 59 {
		if _, _, err = c.create("source", ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err = c.create("source", ""); err == nil {
		t.Fatal("签发未限流")
	}
	clock = clock.Add(time.Minute)
	if _, _, err = c.create("source", ""); err != nil {
		t.Fatal("限流窗口结束仍拒绝")
	}
}

func TestResourceTicketsScopePersistenceAndRevocation(t *testing.T) {
	f := newFixture(t)
	f.write("assets/image.png", "image")
	f.write("private.md", "secret")
	ticket := decode[struct{ URL string }](t, f.do(f.admin, "POST", "/api/v1/auth/tickets", `{"kind":"images"}`, nil))
	res := f.do(newClient(), "GET", ticket.URL+"assets/image.png", "", nil)
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || string(body) != "image" || res.Header.Get("Cache-Control") != "no-store" || res.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("图片票据无法安全加载")
	}
	if f.status(newClient(), "GET", ticket.URL+"private.md", "", nil) != 403 {
		t.Fatal("图片票据越权读取笔记")
	}
	if f.status(newClient(), "GET", strings.Replace(ticket.URL, "/images/", "/fonts/", 1)+"x/file", "", nil) != 403 {
		t.Fatal("票据用途越界")
	}
	token := strings.Split(ticket.URL, "/")[4]
	stored, ok, err := f.store.Ticket(tokenHash(token), false, time.Now())
	if err != nil || !ok || stored.SessionHash == "" {
		t.Fatal("票据未持久保存")
	}
	eventTicket := decode[struct{ URL string }](t, f.do(f.admin, "POST", "/api/v1/auth/tickets", `{"kind":"events"}`, nil))
	eventID := strings.Split(eventTicket.URL, "/")[4]
	first, ok, err := f.store.Ticket(tokenHash(eventID), true, time.Now())
	if err != nil || !ok || time.Until(first.ExpiresAt) > time.Minute {
		t.Fatal("事件票据不符")
	}
	if _, ok, err = f.store.Ticket(tokenHash(eventID), true, time.Now()); err != nil || ok {
		t.Fatal("事件票据可复用")
	}
	f.do(f.admin, "POST", "/api/v1/auth/logout", "", nil)
	if f.status(newClient(), "GET", ticket.URL+"assets/image.png", "", nil) != 401 {
		t.Fatal("注销后资源票据仍有效")
	}
	if strings.Contains(logPath(ticket.URL), token) {
		t.Fatal("日志泄露票据")
	}
}

func TestCaptchaSourceBinding(t *testing.T) {
	c := newCaptchas()
	id, _, err := c.create("one", "")
	if err != nil {
		t.Fatal(err)
	}
	if c.consume("two", id, "123456") == nil {
		t.Fatal("挑战未绑定来源")
	}
}

func TestJSONEnvelopeAndConflict(t *testing.T) {
	f := newFixture(t)
	f.write("a.md", "original")
	res := f.do(f.admin, "PUT", "/api/v1/files/a.md", "changed", map[string]string{"If-Match": "\"wrong\""})
	var result struct {
		Code    int
		Data    struct{ Rev string }
		Message string
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil || res.StatusCode != 412 || result.Code != CodeConflict || result.Data.Rev == "" || result.Message == "" {
		t.Fatal("冲突协议丢失版本或错误语义")
	}
	recorder := httptest.NewRecorder()
	writeError(recorder, 403, "拒绝")
	var failure response
	if err := json.Unmarshal(recorder.Body.Bytes(), &failure); err != nil || failure.Code != 40300 || failure.Data != nil {
		t.Fatal("错误外壳不符")
	}
}
