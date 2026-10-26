package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"rawmark/internal/i18n"
	"strings"
)

func localized(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Content-Language", string(i18n.Negotiate(r.Header.Get("Accept-Language"))))
		}
		next.ServeHTTP(w, r)
	})
}
func responseLocale(w http.ResponseWriter) i18n.Locale {
	return i18n.Negotiate(w.Header().Get("Content-Language"))
}
func message(w http.ResponseWriter, key string, args ...any) string {
	return i18n.Text(responseLocale(w), key, args...)
}
func validateLocale(settings map[string]json.RawMessage) error {
	if raw, ok := settings["locale"]; ok {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return nil
		}
		var locale string
		if err := json.Unmarshal(raw, &locale); err != nil || (locale != "en" && locale != "zh-CN") {
			return i18n.New("invalid_locale")
		}
	}
	return nil
}
