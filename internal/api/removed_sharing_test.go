package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestRemovedShareAPIsReturnNotFound(t *testing.T) {
	f := newFixture(t)
	token := decode[struct{ Token string }](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"automation","scope":"write"}`, nil)).Token
	for _, caller := range []struct {
		name    string
		client  *http.Client
		headers map[string]string
	}{
		{"guest", newClient(), nil},
		{"session", f.admin, nil},
		{"token", newClient(), map[string]string{"Authorization": "Bearer " + token}},
	} {
		t.Run(caller.name, func(t *testing.T) {
			for _, endpoint := range []struct{ method, path string }{
				{"GET", "/api/v1/shares"},
				{"POST", "/api/v1/shares"},
				{"DELETE", "/api/v1/shares/old-token"},
				{"GET", "/api/v1/public/shares/old-token"},
				{"HEAD", "/api/v1/public/shares/old-token"},
				{"GET", "/api/v1/public/shares/old-token/appearance"},
				{"POST", "/api/v1/public/shares/old-token/unlock"},
				{"GET", "/api/v1/public/shares/old-token/assets/image.png"},
			} {
				if code := f.status(caller.client, endpoint.method, endpoint.path, "{}", caller.headers); code != http.StatusNotFound {
					t.Errorf("%s %s：得到 %d，期望 404", endpoint.method, endpoint.path, code)
				}
			}
		})
	}
}

func TestRemovedSharePagesDoNotFallBackToApplication(t *testing.T) {
	handler := newStaticHandler(fstest.MapFS{
		"index.html":    {Data: []byte("app entry")},
		"assets/app.js": {Data: []byte("app script")},
	})
	for _, method := range []string{"GET", "HEAD"} {
		for _, path := range []string{"/s", "/s/", "/s/old-token", "/s/old-token/child", "/share.html"} {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(method, path, nil))
			if recorder.Code != http.StatusNotFound {
				t.Errorf("%s %s：得到 %d，期望 404", method, path, recorder.Code)
			}
		}
	}
	for _, path := range []string{"/", "/assets/app.js"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest("GET", path, nil))
		if recorder.Code != http.StatusOK {
			t.Errorf("%s：应用资源无法读取：%d", path, recorder.Code)
		}
	}
}
