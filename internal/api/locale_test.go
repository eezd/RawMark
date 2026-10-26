package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"rawmark/internal/search"
	"rawmark/internal/vault"
	"reflect"
	"strings"
	"testing"
	"time"

	"rawmark/internal/i18n"
)

func localizedResponse(t *testing.T, res *http.Response) response {
	t.Helper()
	defer res.Body.Close()
	var body response
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body
}
func TestLocalizedHTTPContracts(t *testing.T) {
	f := newFixture(t)
	for _, language := range []string{"en", "zh-CN"} {
		h := map[string]string{"Accept-Language": language}
		res := f.do(newClient(), "GET", "/api/v1/settings", "", h)
		if res.StatusCode != 401 || res.Header.Get("Content-Language") != language || res.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("authentication response contract changed")
		}
		body := localizedResponse(t, res)
		want := "Please sign in"
		if language == "zh-CN" {
			want = "请先登录"
		}
		if body.Message != want || body.Code != 40100 {
			t.Fatalf("%s: %+v", language, body)
		}
		res = f.do(f.admin, "PATCH", "/api/v1/settings", `{"locale":"fr"}`, h)
		if res.StatusCode != 400 {
			t.Fatal("invalid locale accepted")
		}
		if body := localizedResponse(t, res); body.Code != 40000 || body.Message != i18n.Text(i18n.Locale(language), "invalid_locale") {
			t.Fatal(body)
		}
		id, _ := challengeFor(t, f)
		res = f.do(newClient(), "POST", "/api/v1/auth/login", loginBody(id, "invalid", "password123"), h)
		if res.StatusCode != 400 {
			t.Fatal("invalid captcha status changed")
		}
		if body := localizedResponse(t, res); body.Code != CodeCaptchaInvalid || !strings.Contains(body.Message, map[string]string{"en": "Refresh", "zh-CN": "刷新"}[language]) {
			t.Fatal(body)
		}
		id, code := challengeFor(t, f)
		f.server.captchas.mu.Lock()
		challenge := f.server.captchas.challenges[id]
		challenge.expires = time.Now().Add(-time.Second)
		f.server.captchas.challenges[id] = challenge
		f.server.captchas.mu.Unlock()
		res = f.do(newClient(), "POST", "/api/v1/auth/login", loginBody(id, code, "password123"), h)
		if body := localizedResponse(t, res); body.Code != CodeCaptchaExpired {
			t.Fatal(body)
		}
	}
	for _, value := range []string{`{"locale":"zh-CN"}`, `{"locale":"en"}`, `{"locale":null}`} {
		res := f.do(f.admin, "PATCH", "/api/v1/settings", value, nil)
		if res.StatusCode != 200 {
			t.Fatal("valid language rejected")
		}
		res.Body.Close()
	}
	if err := validatePreferences(map[string]json.RawMessage{settingsKey: json.RawMessage(`{"locale":"fr"}`)}); !errors.Is(err, errMaintenanceInput) {
		t.Fatal("invalid imported language accepted")
	}
}
func TestMaintenanceStatusIsRenderedForEachReader(t *testing.T) {
	f := newFixture(t)
	if err := f.server.maintain("export_backup_e9d3dd", func() error { return i18n.New("invalid_locale") }); err == nil {
		t.Fatal("missing failure")
	}
	for _, language := range []string{"en", "zh-CN"} {
		data := decode[maintenanceStatus](t, f.do(f.admin, "GET", "/api/v1/maintenance/status", "", map[string]string{"Accept-Language": language}))
		if data.Operation != i18n.Text(i18n.Locale(language), "export_backup_e9d3dd") || data.Error != i18n.Text(i18n.Locale(language), "invalid_locale") {
			t.Fatal(data)
		}
	}
}

func TestLocalizedResultDetailsDoNotRewriteSourceData(t *testing.T) {
	f := newFixture(t)
	const content = "---\ntitle: User title\ntags: 1\n---\nUser content\n"
	f.write("bad.md", content)
	f.write("used.md", "![](./assets/used.png)")
	f.write("assets/used.png", "synthetic image")
	if err := f.server.index.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, language := range []string{"en", "zh-CN"} {
		h := map[string]string{"Accept-Language": language}
		result := decode[struct {
			Notes []struct {
				Path     string
				Warnings []string
			}
		}](t, f.do(f.admin, "GET", "/api/v1/metadata", "", h))
		found := false
		for _, note := range result.Notes {
			if note.Path == "bad.md" {
				found = true
				if len(note.Warnings) != 1 || note.Warnings[0] != i18n.Text(i18n.Locale(language), "metadata_tags") {
					t.Fatal(note.Warnings)
				}
			}
		}
		if !found {
			t.Fatal("note missing")
		}
		// Metadata warnings still block destructive cleanup, in the requested language.
		res := f.do(f.admin, "POST", "/api/v1/assets/cleanup", `{"paths":["assets/used.png"]}`, h)
		body := localizedResponse(t, res)
		if res.StatusCode != 400 || !strings.Contains(body.Message, i18n.Text(i18n.Locale(language), "metadata_tags")) {
			t.Fatal(body)
		}
	}
	got, _, err := f.server.vault.Read("bad.md")
	if err != nil || string(got) != content {
		t.Fatal("localization changed note contents")
	}
	if _, err := f.server.vault.Delete("bad.md"); err != nil {
		t.Fatal(err)
	}
	for _, language := range []string{"en", "zh-CN"} {
		result := decode[vault.CleanupResult](t, f.do(f.admin, "POST", "/api/v1/assets/cleanup", `{"paths":["assets/used.png"]}`, map[string]string{"Accept-Language": language}))
		if len(result.Skipped) != 1 || result.Skipped[0].Reason != i18n.Text(i18n.Locale(language), "image_in_use") {
			t.Fatal(result)
		}
	}
}

func TestLocalizedMetadataSkipsDeletedOrMovedWarningNotes(t *testing.T) {
	for _, operation := range []string{"delete", "move"} {
		t.Run(operation, func(t *testing.T) {
			f := newFixture(t)
			f.write("bad.md", "---\ntags: 1\n---\nOld\n")
			f.write("good.md", "Good\n")
			if err := f.server.index.Rebuild(context.Background()); err != nil {
				t.Fatal(err)
			}
			var err error
			if operation == "delete" {
				_, err = f.server.vault.Delete("bad.md")
			} else {
				_, err = f.server.vault.Move("bad.md", "moved.md")
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, language := range []string{"en", "zh-CN"} {
				res := f.do(f.admin, "GET", "/api/v1/metadata", "", map[string]string{"Accept-Language": language})
				if res.StatusCode != http.StatusOK {
					t.Fatalf("stale warning note invalidated metadata: HTTP %d", res.StatusCode)
				}
				result := decode[struct{ Notes []search.NoteMetadata }](t, res)
				if len(result.Notes) != 1 || result.Notes[0].Path != "good.md" {
					t.Fatalf("unexpected surviving metadata: %+v", result.Notes)
				}
			}
		})
	}
}

func TestLocalizedMetadataKeepsReanalyzedNoteConsistent(t *testing.T) {
	f := newFixture(t)
	f.write("bad.md", "---\ntags: 1\n---\nOld\n")
	if err := f.server.index.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	const latest = "---\ntitle: Updated title\ntags: [new]\n---\n![](./assets/live.png)\n[Note](./other.md)\n"
	f.write("bad.md", latest)
	for _, language := range []string{"en", "zh-CN"} {
		result := decode[struct{ Notes []search.NoteMetadata }](t, f.do(f.admin, "GET", "/api/v1/metadata", "", map[string]string{"Accept-Language": language}))
		if len(result.Notes) != 1 {
			t.Fatal(result)
		}
		note := result.Notes[0]
		if note.Rev != vault.Rev([]byte(latest)) || !reflect.DeepEqual(note.Metadata, vault.Analyze("bad.md", []byte(latest))) {
			t.Fatalf("metadata mixes file revisions: %+v", note)
		}
	}
}

func TestLocalizedMetadataPreservesReadErrors(t *testing.T) {
	f := newFixture(t)
	f.write("bad.md", "---\ntags: 1\n---\nOld\n")
	if err := f.server.index.Rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(f.root, "bad.md")
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(file, 0o755); err != nil {
		t.Fatal(err)
	}
	if res := f.do(f.admin, "GET", "/api/v1/metadata", "", nil); res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("read failure was hidden: HTTP %d", res.StatusCode)
	}
}
