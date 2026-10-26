package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"rawmark/internal/auth"
)

type principal struct {
	Token       string
	SessionHash string
	Scope       string
	ExpiresAt   time.Time
}
type principalKey struct{}

func identity(r *http.Request) principal { return r.Context().Value(principalKey{}).(principal) }
func withIdentity(r *http.Request, p principal) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), principalKey{}, p))
}
func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *Server) requireAuth(next http.Handler, allowAPI bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(header, "Bearer ")
		if !ok || token == "" || strings.ContainsAny(token, " \t\r\n") {
			writeError(w, 401, message(w, "please_sign_in_48144f"))
			return
		}
		p := principal{Token: token}
		var valid bool
		var err error
		if strings.HasPrefix(token, auth.SessionPrefix) {
			p.ExpiresAt, valid, err = s.auth.SessionExpiry(token)
			p.SessionHash = tokenHash(token)
		} else {
			p.Scope, valid, err = s.auth.ValidateAPIToken(token)
		}
		if err != nil {
			internalError(w, r, err)
			return
		}
		if !valid {
			writeError(w, 401, message(w, "credentials_are_invalid_or_expired_e1f63b"))
			return
		}
		if p.SessionHash == "" {
			if !allowAPI {
				writeError(w, 403, message(w, "this_endpoint_requires_a_login_d34b96"))
				return
			}
			if p.Scope != "write" && r.Method != http.MethodGet && r.Method != http.MethodHead && !(r.Method == http.MethodPost && r.URL.Path == "/api/v1/export") {
				writeError(w, 403, message(w, "read_only_tokens_cannot_modify_6cf8e2"))
				return
			}
		}
		next.ServeHTTP(w, withIdentity(r, p))
	})
}

func (s *Server) validPrincipal(p principal) (bool, error) {
	if p.SessionHash != "" {
		_, ok, err := s.store.SessionExpiry(p.SessionHash, time.Now())
		return ok, err
	}
	_, ok, err := s.auth.ValidateAPIToken(p.Token)
	return ok, err
}
