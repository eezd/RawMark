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
	"rawmark/internal/backup"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"rawmark/internal/auth"
	"rawmark/internal/events"
	"rawmark/internal/search"
	"rawmark/internal/store"
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
	store *store.Store
	hub   *events.Hub
	index *search.Index
	// 串行化设置的"读取-合并-写入"
	settingsMu sync.Mutex
	// ThemesDir 指向数据目录中的主题目录；为空时只有内置主题。
	DataDir             string
	ThemesDir           string
	PluginsDir          string
	FontsDir            string
	pluginsMu           sync.Mutex
	BuiltinFontsSize    int64
	activity            sync.RWMutex
	maintenanceMu       sync.Mutex
	maintenanceBusy     atomic.Bool
	restarting          atomic.Bool
	maintenanceStatusMu sync.Mutex
	maintenanceState    maintenanceStatus
	Restart             func()
	Logs                *backup.LogWriter
	Version             string
	eventWG             sync.WaitGroup
}

func New(v *vault.Vault, a *auth.Manager, st *store.Store, hub *events.Hub, index *search.Index) *Server {
	return &Server{vault: v, auth: a, store: st, hub: hub, index: index}
}

// access 为接口的访问要求
type access int

const (
	public access = iota
	// 登录会话或 API 令牌（只读令牌可用 GET 和只读导出接口）
	authed
	// 只允许登录会话：管理 API 令牌，避免令牌给自己扩权
	sessionOnly
)

type route struct {
	pattern string
	access  access
	handler http.HandlerFunc
}

// routes 为全部接口；openapi.json 须与之一致（见 TestOpenAPICoversRoutes）
func (s *Server) routes() []route {
	return []route{
		{"GET /api/v1/health", public, func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) }},
		{"GET /api/v1/openapi.json", public, serveOpenAPI},
		{"GET /api/v1/auth/state", public, s.authState},
		{"POST /api/v1/auth/setup", public, s.setup},
		{"POST /api/v1/auth/login", public, s.login},
		{"POST /api/v1/auth/logout", public, s.logout},
		{"POST /api/v1/auth/password", sessionOnly, s.changePassword},

		{"GET /api/v1/tree", authed, s.tree},
		{"PUT /api/v1/tree-icon", authed, s.setTreeIcon},
		{"GET /api/v1/metadata", authed, s.metadata},
		{"POST /api/v1/export", authed, s.export},
		{"GET /api/v1/files/{path...}", authed, s.readFile},
		{"PUT /api/v1/files/{path...}", authed, s.writeFile},
		{"DELETE /api/v1/files/{path...}", authed, s.deleteFile},
		{"POST /api/v1/move", authed, s.move},
		{"POST /api/v1/folders", authed, s.mkdir},
		{"POST /api/v1/import", authed, s.importNotes},
		{"POST /api/v1/assets", authed, s.uploadAsset},
		{"POST /api/v1/assets/cleanup", authed, s.cleanupImages},
		{"POST /api/v1/assets/import", authed, s.importAsset},
		{"PUT /api/v1/assets/{path...}", authed, s.replaceImage},
		{"GET /api/v1/raw/{path...}", authed, s.raw},
		{"GET /api/v1/trash", authed, s.trashList},
		{"DELETE /api/v1/trash", authed, s.trashClear},
		{"GET /api/v1/storage", sessionOnly, s.getStorage},
		{"GET /api/v1/maintenance/status", sessionOnly, s.maintenanceInfo},
		{"POST /api/v1/maintenance/export/{kind}", sessionOnly, s.exportBackup},
		{"POST /api/v1/maintenance/notes/export", sessionOnly, s.exportNotes},
		{"POST /api/v1/maintenance/uploads", sessionOnly, s.startMaintenanceUpload},
		{"PUT /api/v1/maintenance/uploads/{id}", sessionOnly, s.appendMaintenanceUpload},
		{"POST /api/v1/maintenance/uploads/{id}/validate", sessionOnly, s.validateMaintenanceUpload},
		{"DELETE /api/v1/maintenance/uploads/{id}", sessionOnly, s.deleteMaintenanceUpload},
		{"POST /api/v1/maintenance/settings/import", sessionOnly, s.applySettings},
		{"POST /api/v1/maintenance/settings/reset", sessionOnly, s.resetSettings},
		{"POST /api/v1/maintenance/restore", sessionOnly, s.restoreInstance},
		{"POST /api/v1/maintenance/index/{operation}", sessionOnly, s.maintainIndex},
		{"POST /api/v1/maintenance/temp/clear", sessionOnly, s.clearTemp},
		{"POST /api/v1/maintenance/logs/export", sessionOnly, s.exportLogs},
		{"POST /api/v1/trash/{id}/restore", authed, s.trashRestore},
		{"DELETE /api/v1/trash/{id}", authed, s.trashPurge},
		{"GET /api/v1/events", authed, s.events},
		{"GET /api/v1/search", authed, s.search},

		{"GET /api/v1/settings", authed, s.getSettings},
		{"PATCH /api/v1/settings", sessionOnly, s.patchSettings},
		{"GET /api/v1/fonts", sessionOnly, s.listFonts},
		{"POST /api/v1/fonts", sessionOnly, s.importFont},
		{"GET /api/v1/fonts/{id}/file", sessionOnly, s.fontFile},
		{"DELETE /api/v1/fonts/{id}", sessionOnly, s.deleteFont},
		{"GET /api/v1/plugins", sessionOnly, s.listPlugins},
		{"POST /api/v1/plugins", sessionOnly, s.installPlugin},
		{"PATCH /api/v1/plugins/{id}", sessionOnly, s.togglePlugin},
		{"DELETE /api/v1/plugins/{id}", sessionOnly, s.uninstallPlugin},
		{"GET /api/v1/plugins/{id}/assets/{revision}/{path...}", sessionOnly, s.pluginAsset},
		{"GET /api/v1/plugins/{id}/data", sessionOnly, s.getPluginData},
		{"PUT /api/v1/plugins/{id}/data", sessionOnly, s.putPluginData},
		{"GET /api/v1/themes", authed, s.listThemes},
		{"GET /api/v1/themes/{id}", authed, s.getTheme},
		{"GET /api/v1/tokens", sessionOnly, s.listTokens},
		{"POST /api/v1/tokens", sessionOnly, s.createToken},
		{"DELETE /api/v1/tokens/{id}", sessionOnly, s.deleteToken},
	}
}

func (s *Server) Handler(static fs.FS) http.Handler {
	mux := http.NewServeMux()
	for _, rt := range s.routes() {
		var h http.Handler = rt.handler
		switch rt.access {
		case authed:
			h = s.requireAuth(h, true)
		case sessionOnly:
			h = s.requireAuth(h, false)
		}
		mux.Handle(rt.pattern, h)
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { writeError(w, 404, "接口不存在") })
	mux.Handle("/", newStaticHandler(static))
	return securityHeaders(sameOrigin(s.guardAPI(mux)))
}

// ---- 中间件 ----

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
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

// requireAuth 校验登录会话；allowToken 时也接受 Authorization: Bearer 的 API 令牌
func (s *Server) requireAuth(next http.Handler, allowToken bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if bearer, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
			if !allowToken {
				writeError(w, 403, "此接口只能在登录后使用，不接受 API 令牌")
				return
			}
			scope, valid, err := s.auth.ValidateAPIToken(strings.TrimSpace(bearer))
			if err != nil {
				internalError(w, r, err)
				return
			}
			if !valid {
				writeError(w, 401, "API 令牌无效")
				return
			}
			if scope != "write" && r.Method != http.MethodGet && r.Method != http.MethodHead && !(r.Method == http.MethodPost && r.URL.Path == "/api/v1/export") {
				writeError(w, 403, "只读令牌不能修改数据")
				return
			}
			next.ServeHTTP(w, r)
			return
		}
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
	var body struct{ Password string }
	if !readJSON(w, r, &body) {
		return
	}
	switch err := s.auth.Setup(body.Password); {
	case errors.Is(err, auth.ErrWeakPassword):
		writeError(w, 400, err.Error())
	case errors.Is(err, auth.ErrAlreadySetUp):
		writeError(w, 409, err.Error())
	case err != nil:
		internalError(w, r, err)
	default:
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
	token, err := s.auth.Login(clientIP(r), password)
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

func (s *Server) setTreeIcon(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string          `json:"path"`
		Icon json.RawMessage `json:"icon"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	var icon *vault.TreeIcon
	if len(body.Icon) == 0 || json.Unmarshal(body.Icon, &icon) != nil {
		writeError(w, 400, "请求格式错误：需要 icon（null 恢复默认）")
		return
	}
	if err := s.vault.SetTreeIcon(body.Path, icon); err != nil {
		vaultError(w, r, err)
		return
	}
	s.hub.Broadcast(events.Event{Type: "tree"})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

const searchLimit = 50

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	results, err := s.index.Search(r.URL.Query().Get("q"), searchLimit)
	if err != nil {
		internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"results": results})
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
	rewritten, err := s.vault.Move(body.From, body.To)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	if rewritten {
		// 原子改写替换了文件身份，监听器无法再从快照中识别这次移动。
		s.hub.Broadcast(events.Event{Type: "moved", From: body.From, Path: body.To}, events.Event{Type: "tree"})
	} else {
		// 图标提交在文件移动之后；不能仅依赖文件监听器较早的通知。
		s.hub.Broadcast(events.Event{Type: "tree"})
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

// uploadAsset 接收 multipart 表单中的 file 字段，存入指定笔记或目录下的共享 assets 目录。
func (s *Server) uploadAsset(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAssetBytes+1<<20)
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, "缺少上传文件")
		return
	}
	defer file.Close()
	var link string
	if r.URL.Query().Has("folder") {
		if r.URL.Query().Has("note") {
			writeError(w, 400, "不能同时指定笔记和文件夹")
			return
		}
		link, err = s.vault.SaveFolderAsset(r.URL.Query().Get("folder"), header.Filename, file, maxAssetBytes)
	} else {
		link, err = s.vault.SaveAsset(r.URL.Query().Get("note"), header.Filename, file, maxAssetBytes)
	}
	if err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]string{"link": link})
}

// replaceImage 仅替换已存在的图片；路径与引用保持不变。
func (s *Server) replaceImage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAssetBytes+1<<20)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, 413, "图片不能超过 50 MB")
		} else {
			writeError(w, 400, "无法读取上传文件")
		}
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, "缺少上传文件")
		return
	}
	defer file.Close()
	if err := s.vault.ReplaceImage(r.PathValue("path"), header.Filename, file, maxAssetBytes); err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// raw 输出仓库内任意非隐藏文件（主要是图片）。以沙箱 CSP 返回，防止 SVG/HTML 中的脚本在本站执行
func (s *Server) raw(w http.ResponseWriter, r *http.Request) {
	s.serveRaw(w, r, r.PathValue("path"))
}

func (s *Server) serveRaw(w http.ResponseWriter, r *http.Request, rel string) {
	f, info, err := s.vault.OpenRaw(rel)
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
	h.Set("Cache-Control", "no-store")
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
	s.hub.Broadcast(events.Event{Type: "tree"})
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

// clientIP 返回限速用的来源地址（未经反向代理头部，避免伪造）
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

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
	case errors.Is(err, vault.ErrInvalidPath), errors.Is(err, vault.ErrInvalidImport), errors.Is(err, vault.ErrInvalidIcon):
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

func (s *Server) metadata(w http.ResponseWriter, r *http.Request) {
	notes, ready, err := s.index.Metadata()
	if err != nil {
		internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"notes": notes, "ready": ready})
}
