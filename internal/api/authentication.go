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
			writeError(w, 401, "请先登录")
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
			writeError(w, 401, "登录凭据无效或已过期")
			return
		}
		if p.SessionHash == "" {
			if !allowAPI {
				writeError(w, 403, "此接口需要登录会话")
				return
			}
			if p.Scope != "write" && r.Method != http.MethodGet && r.Method != http.MethodHead && !(r.Method == http.MethodPost && r.URL.Path == "/api/v1/export") {
				writeError(w, 403, "只读令牌不能修改数据")
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
