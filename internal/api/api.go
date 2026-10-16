// Package api 提供 REST API（/api/v1）、事件推送与前端静态资源。前端只通过这套 API 访问数据。
package api

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"path"
	"strings"
	"time"

	"rawmark/internal/auth"
	"rawmark/internal/events"
	"rawmark/internal/vault"
)

const (
	cookieName    = "rawmark_session"
	maxNoteBytes  = 20 << 20
	maxAssetBytes = 50 << 20
	maxJSONBytes  = 1 << 20
)

type Server struct {
	vault *vault.Vault
	auth  *auth.Manager
	hub   *events.Hub
	// OnSetup 在首次初始化完成后调用（用于删除启动码文件）
	OnSetup func()
}

func New(v *vault.Vault, a *auth.Manager, hub *events.Hub) *Server {
	return &Server{vault: v, auth: a, hub: hub}
}

func (s *Server) Handler(static fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) })
	mux.HandleFunc("GET /api/v1/auth/state", s.authState)
	mux.HandleFunc("POST /api/v1/auth/setup", s.setup)
	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	mux.HandleFunc("POST /api/v1/auth/logout", s.logout)

	protected := map[string]http.HandlerFunc{
		"GET /api/v1/tree":                s.tree,
		"GET /api/v1/files/{path...}":     s.readFile,
		"PUT /api/v1/files/{path...}":     s.writeFile,
		"DELETE /api/v1/files/{path...}":  s.deleteFile,
		"POST /api/v1/move":               s.move,
		"POST /api/v1/folders":            s.mkdir,
		"POST /api/v1/assets":             s.uploadAsset,
		"GET /api/v1/raw/{path...}":       s.raw,
		"GET /api/v1/trash":               s.trashList,
		"POST /api/v1/trash/{id}/restore": s.trashRestore,
		"DELETE /api/v1/trash/{id}":       s.trashPurge,
		"GET /api/v1/events":              s.events,
	}
	for pattern, h := range protected {
		mux.Handle(pattern, s.requireAuth(h))
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { writeError(w, 404, "接口不存在") })
	mux.Handle("/", newStaticHandler(static))
	return securityHeaders(sameOrigin(mux))
}

// ---- 中间件 ----

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// sameOrigin 拒绝跨站的写请求（CSRF 防护的第二道防线，第一道是 SameSite=Strict Cookie）。
// 没有 Origin 头的请求来自非浏览器客户端，放行
func sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if origin := r.Header.Get("Origin"); origin != "" {
				if host := strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://"); host != r.Host {
					writeError(w, 403, "跨站请求被拒绝")
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName)
		if err != nil {
			writeError(w, 401, "未登录")
			return
		}
		ok, err := s.auth.Validate(c.Value)
		if err != nil {
			internalError(w, r, err)
			return
		}
		if !ok {
			writeError(w, 401, "登录已过期")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---- 鉴权 ----

func (s *Server) authState(w http.ResponseWriter, r *http.Request) {
	setUp, err := s.auth.IsSetUp()
	if err != nil {
		internalError(w, r, err)
		return
	}
	authed := false
	if c, err := r.Cookie(cookieName); err == nil {
		if authed, err = s.auth.Validate(c.Value); err != nil {
			internalError(w, r, err)
			return
		}
	}
	writeJSON(w, 200, map[string]bool{"setUp": setUp, "authenticated": authed})
}

func (s *Server) setup(w http.ResponseWriter, r *http.Request) {
	var body struct{ Code, Password string }
	if !readJSON(w, r, &body) {
		return
	}
	switch err := s.auth.Setup(body.Code, body.Password); {
	case errors.Is(err, auth.ErrBadSetupCode), errors.Is(err, auth.ErrWeakPassword):
		writeError(w, 400, err.Error())
	case errors.Is(err, auth.ErrAlreadySetUp):
		writeError(w, 409, err.Error())
	case err != nil:
		internalError(w, r, err)
	default:
		if s.OnSetup != nil {
			s.OnSetup()
		}
		s.startSession(w, r, body.Password)
	}
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct{ Password string }
	if !readJSON(w, r, &body) {
		return
	}
	s.startSession(w, r, body.Password)
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, password string) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	token, err := s.auth.Login(host, password)
	switch {
	case errors.Is(err, auth.ErrRateLimited):
		writeError(w, 429, err.Error())
	case errors.Is(err, auth.ErrBadCredentials):
		writeError(w, 401, err.Error())
	case err != nil:
		internalError(w, r, err)
	default:
		http.SetCookie(w, &http.Cookie{
			Name:     cookieName,
			Value:    token,
			Path:     "/",
			MaxAge:   int(auth.SessionTTL / time.Second),
			HttpOnly: true,
			Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
			SameSite: http.SameSiteStrictMode,
		})
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(cookieName); err == nil {
		if err := s.auth.Logout(c.Value); err != nil {
			internalError(w, r, err)
			return
		}
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---- 文件 ----

func (s *Server) tree(w http.ResponseWriter, r *http.Request) {
	entries, err := s.vault.Tree()
	if err != nil {
		internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"entries": entries})
}

func (s *Server) readFile(w http.ResponseWriter, r *http.Request) {
	data, rev, err := s.vault.Read(r.PathValue("path"))
	if err != nil {
		vaultError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("ETag", `"`+rev+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

// writeFile 以请求体整体作为笔记内容。If-Match: "rev" 要求版本一致；If-None-Match: * 要求文件不存在；都不带则直接覆盖
func (s *Server) writeFile(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxNoteBytes))
	if err != nil {
		writeError(w, 413, "笔记过大")
		return
	}
	pre := vault.Precondition{
		IfMatch:     strings.Trim(r.Header.Get("If-Match"), `"`),
		IfNoneMatch: r.Header.Get("If-None-Match") == "*",
	}
	rev, err := s.vault.Write(r.PathValue("path"), data, pre)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	w.Header().Set("ETag", `"`+rev+`"`)
	writeJSON(w, 200, map[string]string{"rev": rev})
}

func (s *Server) deleteFile(w http.ResponseWriter, r *http.Request) {
	item, err := s.vault.Delete(r.PathValue("path"))
	if err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, item)
}

func (s *Server) move(w http.ResponseWriter, r *http.Request) {
	var body struct{ From, To string }
	if !readJSON(w, r, &body) {
		return
	}
	if err := s.vault.Move(body.From, body.To); err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) mkdir(w http.ResponseWriter, r *http.Request) {
	var body struct{ Path string }
	if !readJSON(w, r, &body) {
		return
	}
	if err := s.vault.Mkdir(body.Path); err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// uploadAsset 接收 multipart 表单中的 file 字段，存入 ?note= 指定笔记的 .assets 目录
func (s *Server) uploadAsset(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAssetBytes+1<<20)
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, "缺少上传文件")
		return
	}
	defer file.Close()
	link, err := s.vault.SaveAsset(r.URL.Query().Get("note"), header.Filename, file, maxAssetBytes)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]string{"link": link})
}

// raw 输出仓库内任意非隐藏文件（主要是图片）。以沙箱 CSP 返回，防止 SVG/HTML 中的脚本在本站执行
func (s *Server) raw(w http.ResponseWriter, r *http.Request) {
	f, info, err := s.vault.OpenRaw(r.PathValue("path"))
	if err != nil {
		vaultError(w, r, err)
		return
	}
	defer f.Close()
	h := w.Header()
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
	if ct := mime.TypeByExtension(path.Ext(info.Name())); ct != "" {
		h.Set("Content-Type", ct)
	}
	h.Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

// ---- 回收站 ----

func (s *Server) trashList(w http.ResponseWriter, r *http.Request) {
	items, err := s.vault.TrashList()
	if err != nil {
		internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *Server) trashRestore(w http.ResponseWriter, r *http.Request) {
	item, err := s.vault.Restore(r.PathValue("id"))
	if err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, item)
}

func (s *Server) trashPurge(w http.ResponseWriter, r *http.Request) {
	if err := s.vault.Purge(r.PathValue("id")); err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---- 响应工具 ----

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBytes)).Decode(v); err != nil {
		writeError(w, 400, "请求格式错误")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func internalError(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("请求处理失败", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, 500, "服务器内部错误")
}

func vaultError(w http.ResponseWriter, r *http.Request, err error) {
	var conflict *vault.ConflictError
	switch {
	case errors.As(err, &conflict):
		writeJSON(w, 412, map[string]string{"error": err.Error(), "rev": conflict.Rev})
	case errors.Is(err, vault.ErrInvalidPath):
		writeError(w, 400, err.Error())
	case errors.Is(err, vault.ErrNotFound):
		writeError(w, 404, err.Error())
	case errors.Is(err, vault.ErrExists):
		writeError(w, 409, err.Error())
	case errors.Is(err, vault.ErrTooLarge):
		writeError(w, 413, err.Error())
	default:
		internalError(w, r, err)
	}
}
