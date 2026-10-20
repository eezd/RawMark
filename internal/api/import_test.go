package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rawmark/internal/vault"
)

func TestImportImageAddressBoundary(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.100.100.200", "0.1.2.3", "198.18.0.1", "224.0.0.1", "240.0.0.1", "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001::1", "2001:db8::1", "3fff::1"} {
		if publicImageIP(netip.MustParseAddr(address)) {
			t.Errorf("不应接受内网或特殊用途地址 %s", address)
		}
	}
	for _, address := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		if !publicImageIP(netip.MustParseAddr(address)) {
			t.Errorf("应接受公网地址 %s", address)
		}
	}
	f := newFixture(t)
	f.write("n.md", "正文")
	for _, source := range []string{"file:///etc/passwd", "ftp://example.com/a.png", "https://user:password@example.com/a.png", "http://127.0.0.1/a.png", "http://[::1]/a.png", "http://localhost/a.png"} {
		body, err := json.Marshal(map[string]string{"url": source})
		if err != nil {
			t.Fatal(err)
		}
		if code := f.status(f.admin, "POST", "/api/v1/assets/import?note=n.md", string(body), nil); code != 400 {
			t.Fatalf("应拒绝非公网图片来源，得到 %d", code)
		}
	}
	if code := f.status(newClient(), "POST", "/api/v1/assets/import?note=n.md", `{"url":"https://example.com/a.png"}`, nil); code != 401 {
		t.Fatalf("未登录不允许下载: %d", code)
	}
}

func TestImportImageDownloadAndRedirects(t *testing.T) {
	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT6sAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	attempts := map[string]int{}
	var ownerRoot string
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts[r.URL.Path]++
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Referer") != "" {
			t.Error("下载请求泄露了凭据或来源")
		}
		switch r.URL.Path {
		case "/private":
			http.Redirect(w, r, "http://127.0.0.1/private.png", http.StatusFound)
		case "/scheme":
			http.Redirect(w, r, "file:///etc/passwd", http.StatusFound)
		case "/redirect":
			http.Redirect(w, r, "/image", http.StatusFound)
		case "/loop":
			http.Redirect(w, r, "/loop", http.StatusFound)
		case "/retry":
			if attempts[r.URL.Path] == 1 {
				w.WriteHeader(503)
				return
			}
			w.Write(png)
		case "/failed":
			w.WriteHeader(429)
		case "/missing":
			w.WriteHeader(404)
		case "/renamed":
			if err := os.Rename(filepath.Join(ownerRoot, "moving.md"), filepath.Join(ownerRoot, "moved.md")); err != nil {
				t.Error(err)
			}
			w.Write(png)
		case "/html":
			w.Header().Set("Content-Type", "image/png")
			io.WriteString(w, "<script>not an image</script>")
		default:
			w.Header().Set("Content-Type", "text/plain")
			w.Write(png)
		}
	}))
	defer source.Close()
	original := remoteImageClient
	transport := original.Transport.(*http.Transport).Clone()
	dial := transport.DialContext
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		// 只把固定的测试来源映射到本地真实 HTTP 服务，其他目标仍走生产地址校验。
		if address == "images.example:80" {
			return (&net.Dialer{}).DialContext(ctx, network, source.Listener.Addr().String())
		}
		return dial(ctx, network, address)
	}
	client := *original
	client.Transport = transport
	remoteImageClient = &client
	t.Cleanup(func() { transport.CloseIdleConnections(); remoteImageClient = original })
	f := newFixture(t)
	ownerRoot = f.root
	f.write("n.md", "正文")
	for _, route := range []string{"/image", "/redirect", "/retry"} {
		body := `{"url":"http://images.example` + route + `"}`
		result := decode[map[string]string](t, f.do(f.admin, "POST", "/api/v1/assets/import?note=n.md", body, nil))
		data, err := os.ReadFile(filepath.Join(f.root, filepath.FromSlash(result["link"])))
		if err != nil || !bytes.Equal(data, png) || !strings.HasSuffix(result["link"], ".png") {
			t.Fatalf("导入内容、类型或路径不符: %v", err)
		}
	}
	for route, expected := range map[string]int{"/private": 400, "/scheme": 400, "/loop": 502, "/html": 422, "/missing": 502, "/failed": 502} {
		body := `{"url":"http://images.example` + route + `"}`
		if code := f.status(f.admin, "POST", "/api/v1/assets/import?note=n.md", body, nil); code != expected {
			t.Errorf("%s 应返回 %d，得到 %d", route, expected, code)
		}
	}
	if attempts["/retry"] != 2 || attempts["/failed"] != 2 || attempts["/missing"] != 1 || attempts["/loop"] != 5 {
		t.Fatalf("重试或重定向没有遵守上限: %v", attempts)
	}
	f.write("moving.md", "正文")
	if code := f.status(f.admin, "POST", "/api/v1/assets/import?note=moving.md", `{"url":"http://images.example/renamed"}`, nil); code != 404 {
		t.Fatalf("下载期间移动的笔记不应写入旧路径: %d", code)
	}
	if _, err := os.Stat(filepath.Join(f.root, "moving.assets")); !os.IsNotExist(err) {
		t.Fatalf("不应在旧位置创建资源: %v", err)
	}
}

func TestReadImageDownloadSizeLimit(t *testing.T) {
	_, _, err := readImageDownload(bytes.NewReader(make([]byte, maxAssetBytes+1)))
	if !errors.Is(err, vault.ErrTooLarge) {
		t.Fatalf("超限图片应被拒绝: %v", err)
	}
}
