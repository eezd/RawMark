// Package api serves the REST API (/api/v1), events, and frontend assets. The frontend accesses data only through this API.
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
	"rawmark/internal/i18n"
	"strings"
	"sync"
	"sync/atomic"

	"rawmark/internal/auth"
	"rawmark/internal/events"
	"rawmark/internal/search"
	"rawmark/internal/store"
	"rawmark/internal/vault"
)

const (
	maxNoteBytes  = 20 << 20
	maxAssetBytes = 50 << 20
	maxJSONBytes  = 1 << 20
)

type Server struct {
	vault    *vault.Vault
	auth     *auth.Manager
	captchas *captchaManager
	store    *store.Store
	hub      *events.Hub
	index    *search.Index
	// Serialize settings read/merge/write operations.
	settingsMu sync.Mutex
	// ThemesDir points to the data directory's themes folder; an empty value enables only built-in themes.
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
	return &Server{vault: v, auth: a, store: st, hub: hub, index: index, captchas: newCaptchas()}
}

// access defines an endpoint's access requirement.
type access int

const (
	public access = iota
	// Login session or API token (read-only tokens may use GET and read-only exports).
	authed
	// Login sessions only: prevent API tokens from expanding their own permissions through token management.
	sessionOnly
)

type route struct {
	pattern string
	access  access
	handler http.HandlerFunc
}

// routes lists all endpoints; openapi.json must match it (see TestOpenAPICoversRoutes).
func (s *Server) routes() []route {
	return []route{
		{"GET /api/v1/health", public, func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) }},
		{"GET /api/v1/openapi.json", public, serveOpenAPI},
		{"GET /api/v1/auth/state", public, s.authState},
		{"POST /api/v1/auth/setup", public, s.setup},
		{"POST /api/v1/auth/login", public, s.login},
		{"POST /api/v1/auth/logout", sessionOnly, s.logout},
		{"GET /api/v1/auth/me", sessionOnly, s.me},
		{"POST /api/v1/auth/captcha", public, s.createCaptcha},
		{"POST /api/v1/auth/tickets", sessionOnly, s.createTicket},
		{"GET /api/v1/resources/{ticket}/{kind}/{path...}", public, s.resource},
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
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, 404, message(w, "api_endpoint_not_found_c49d86"))
	})
	mux.Handle("/", newStaticHandler(static))
	return localized(securityHeaders(sameOrigin(s.guardAPI(mux))))
}

// ---- Middleware ----

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

// sameOrigin preserves the same-origin boundary for writes; Bearer authentication does not rely on browser Cookies.
// Requests without Origin come from non-browser clients and are allowed.
func sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if origin := r.Header.Get("Origin"); origin != "" {
				if host := strings.TrimPrefix(strings.TrimPrefix(origin, "https://"), "http://"); host != r.Host {
					writeError(w, 403, message(w, "cross_site_request_rejected_5e7a50"))
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// ---- Authentication ----

func (s *Server) authState(w http.ResponseWriter, r *http.Request) {
	setUp, err := s.auth.IsSetUp()
	if err != nil {
		internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"setUp": setUp})
}

func (s *Server) setup(w http.ResponseWriter, r *http.Request) {
	var body struct{ Password string }
	if !readJSON(w, r, &body) {
		return
	}
	switch err := s.auth.Setup(body.Password); {
	case errors.Is(err, auth.ErrWeakPassword):
		writeError(w, 400, i18n.RenderError(err, responseLocale(w)))
	case errors.Is(err, auth.ErrAlreadySetUp):
		writeError(w, 409, i18n.RenderError(err, responseLocale(w)))
	case err != nil:
		internalError(w, r, err)
	default:
		s.startSession(w, r, body.Password, nil)
	}
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password    string
		CaptchaID   string `json:"captchaId"`
		CaptchaCode string `json:"captchaCode"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	s.startSession(w, r, body.Password, func() error { return s.captchas.consume(clientIP(r), body.CaptchaID, body.CaptchaCode) })
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, password string, challenge func() error) {
	token, err := s.auth.AttemptLogin(clientIP(r), password, challenge)
	switch {
	case errors.Is(err, auth.ErrRateLimited):
		writeError(w, 429, i18n.RenderError(err, responseLocale(w)))
	case errors.Is(err, errCaptchaInvalid):
		writeFailure(w, 400, CodeCaptchaInvalid, i18n.RenderError(err, responseLocale(w)), nil)
	case errors.Is(err, errCaptchaExpired):
		writeFailure(w, 400, CodeCaptchaExpired, i18n.RenderError(err, responseLocale(w)), nil)
	case errors.Is(err, auth.ErrBadCredentials):
		writeFailure(w, 401, CodeBadCredentials, i18n.RenderError(err, responseLocale(w)), nil)
	case err != nil:
		internalError(w, r, err)
	default:
		expires, _, err := s.auth.SessionExpiry(token)
		if err != nil {
			internalError(w, r, err)
			return
		}
		writeJSON(w, 200, map[string]any{"token": token, "expiresAt": expires})
	}
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if err := s.auth.Logout(identity(r).Token); err != nil {
		internalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"permissions": []string{"vault:read", "vault:write", "instance:manage"}, "expiresAt": identity(r).ExpiresAt})
}

// ---- Files ----

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
		writeError(w, 400, message(w, "invalid_request_icon_is_required_16149e"))
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
	// Preserve the strong revision ETag through compression proxies for If-Match writes.
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Write(data)
}

// writeFile uses the entire request body as note content. If-Match: "rev" requires a matching revision; If-None-Match: * requires a new file; omitting both overwrites unconditionally.
func (s *Server) writeFile(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxNoteBytes))
	if err != nil {
		writeError(w, 413, message(w, "note_is_too_large_86d890"))
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
		// Atomic rewriting replaced the file identity, so the watcher can no longer identify this move from its snapshot.
		s.hub.Broadcast(events.Event{Type: "moved", From: body.From, Path: body.To}, events.Event{Type: "tree"})
	} else {
		// Icons commit after the file move; the watcher's earlier notification alone is insufficient.
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

// uploadAsset accepts the multipart file field and saves it in the shared assets directory for the selected note or folder.
func (s *Server) uploadAsset(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAssetBytes+1<<20)
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, message(w, "upload_file_is_missing_a2be00"))
		return
	}
	defer file.Close()
	var link string
	if r.URL.Query().Has("folder") {
		if r.URL.Query().Has("note") {
			writeError(w, 400, message(w, "a_note_and_a_folder_8b62b5"))
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

// replaceImage replaces only an existing image, preserving its path and references.
func (s *Server) replaceImage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAssetBytes+1<<20)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, 413, message(w, "images_must_not_exceed_mb_61d721"))
		} else {
			writeError(w, 400, message(w, "could_not_read_uploaded_file_4f04cc"))
		}
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, message(w, "upload_file_is_missing_a2be00"))
		return
	}
	defer file.Close()
	if err := s.vault.ReplaceImage(r.PathValue("path"), header.Filename, file, maxAssetBytes); err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// raw serves any non-hidden vault file (mainly images). A sandbox CSP prevents SVG/HTML scripts from running on this origin.
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

// ---- Recycle bin ----

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

// ---- Response helpers ----

// clientIP returns the source address for rate limiting, ignoring proxy headers to prevent spoofing.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBytes)).Decode(v); err != nil {
		writeError(w, 400, message(w, "invalid_request_format_2529b1"))
		return false
	}
	return true
}

func internalError(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("请求处理失败", "method", r.Method, "path", logPath(r.URL.Path), "err", err)
	writeError(w, 500, message(w, "internal_server_error_036549"))
}

func vaultError(w http.ResponseWriter, r *http.Request, err error) {
	var conflict *vault.ConflictError
	switch {
	case errors.As(err, &conflict):
		writeFailure(w, 412, CodeConflict, message(w, "version_conflict"), map[string]string{"rev": conflict.Rev})
	case errors.Is(err, vault.ErrInvalidPath), errors.Is(err, vault.ErrInvalidImport), errors.Is(err, vault.ErrInvalidIcon):
		writeError(w, 400, i18n.RenderError(err, responseLocale(w)))
	case errors.Is(err, vault.ErrNotFound):
		writeError(w, 404, i18n.RenderError(err, responseLocale(w)))
	case errors.Is(err, vault.ErrExists):
		writeError(w, 409, i18n.RenderError(err, responseLocale(w)))
	case errors.Is(err, vault.ErrTooLarge):
		writeError(w, 413, i18n.RenderError(err, responseLocale(w)))
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
	// Older derived indexes store rendered warnings. Reanalyze only affected notes
	// and keep each returned note at one revision while the index catches up.
	currentNotes := notes[:0]
	for _, note := range notes {
		if len(note.Warnings) > 0 {
			content, rev, err := s.vault.Read(note.Path)
			if errors.Is(err, vault.ErrNotFound) {
				continue
			}
			if err != nil {
				vaultError(w, r, err)
				return
			}
			note.Metadata = vault.Analyze(note.Path, content)
			note.Rev = rev
			note.Warnings = []string{}
			for _, warning := range note.Diagnostics {
				note.Warnings = append(note.Warnings, i18n.RenderError(warning, responseLocale(w)))
			}
		}
		currentNotes = append(currentNotes, note)
	}
	writeJSON(w, 200, map[string]any{"notes": currentNotes, "ready": ready})
}
