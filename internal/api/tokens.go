package api

import (
	_ "embed"
	"errors"
	"net/http"
	"strings"

	"rawmark/internal/auth"
)

func (s *Server) listTokens(w http.ResponseWriter, r *http.Request) {
	tokens, err := s.store.APITokens()
	if err != nil {
		internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"tokens": tokens})
}

// createToken 返回的 token 明文只出现这一次，服务器只保存哈希
func (s *Server) createToken(w http.ResponseWriter, r *http.Request) {
	var body struct{ Name, Scope string }
	if !readJSON(w, r, &body) {
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" || len([]rune(name)) > 100 {
		writeError(w, 400, "名称不能为空且不超过 100 个字符")
		return
	}
	plain, t, err := s.auth.CreateAPIToken(name, body.Scope)
	if errors.Is(err, auth.ErrBadScope) {
		writeError(w, 400, err.Error())
		return
	}
	if err != nil {
		internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"token": plain, "info": t})
}

func (s *Server) deleteToken(w http.ResponseWriter, r *http.Request) {
	ok, err := s.store.DeleteAPIToken(r.PathValue("id"))
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !ok {
		writeError(w, 404, "令牌不存在")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

//go:embed openapi.json
var openAPISpec []byte

func serveOpenAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write(openAPISpec)
}
