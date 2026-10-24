package api

import (
	"encoding/json"
	"net/http"
	"rawmark/internal/events"
	"rawmark/internal/vault"
	"testing"
	"time"
)

func TestTreeIconAuthAndBroadcast(t *testing.T) {
	f := newFixture(t)
	f.write("a.md", "正文")
	payload := `{"path":"a.md","icon":{"kind":"emoji","value":"📚"}}`
	check := func(client *http.Client, headers map[string]string, want int) {
		t.Helper()
		res := f.do(client, "PUT", "/api/v1/tree-icon", payload, headers)
		res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("设置图标状态: %d，期望 %d", res.StatusCode, want)
		}
	}
	check(newClient(), nil, 401)
	for _, scope := range []string{"read", "write"} {
		token := decode[struct{ Token string }](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"icons","scope":"`+scope+`"}`, nil))
		want := 200
		if scope == "read" {
			want = 403
		}
		check(newClient(), map[string]string{"Authorization": "Bearer " + token.Token}, want)
	}
	ch, cancel := f.hub.Subscribe()
	defer cancel()
	check(f.admin, nil, 200)
	select {
	case msg := <-ch:
		var batch []events.Event
		if err := json.Unmarshal(msg, &batch); err != nil || len(batch) != 1 || batch[0].Type != "tree" {
			t.Fatalf("图标广播不符: %s %v", msg, err)
		}
	case <-time.After(time.Second):
		t.Fatal("缺少 tree 广播")
	}
	tree := decode[struct{ Entries []vault.Entry }](t, f.do(f.admin, "GET", "/api/v1/tree", "", nil))
	if len(tree.Entries) != 1 || tree.Entries[0].Icon == nil || tree.Entries[0].Icon.Value != "📚" {
		t.Fatalf("目录属性不符: %+v", tree)
	}
	res := f.do(f.admin, "PUT", "/api/v1/tree-icon", `{"path":"a.md","icon":null}`, nil)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	tree = decode[struct{ Entries []vault.Entry }](t, f.do(f.admin, "GET", "/api/v1/tree", "", nil))
	if tree.Entries[0].Icon != nil {
		t.Fatal("恢复默认后不应返回覆盖属性")
	}
	for _, body := range []string{`{"path":"a.md"}`, `{"path":"a.md","icon":"📚"}`, `{"path":"a.md","icon":{"kind":"builtin","value":"fake"}}`, `{"path":"../a.md","icon":null}`} {
		res := f.do(f.admin, "PUT", "/api/v1/tree-icon", body, nil)
		res.Body.Close()
		if res.StatusCode != 400 {
			t.Fatal(res.StatusCode)
		}
	}
}
