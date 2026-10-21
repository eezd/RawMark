package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"rawmark/internal/auth"
	"rawmark/internal/events"
	"rawmark/internal/store"
	"rawmark/internal/vault"
)

// 输入分享密码后的凭据 Cookie，按分享限定 Path，同一浏览器可同时打开多个分享
const shareCookieName = "rawmark_share"

// 设有密码的永久分享，访客凭据的有效期
const shareCookieTTL = 30 * 24 * time.Hour

type shareItemView struct {
	store.ShareItem
	Exists bool `json:"exists"`
}
type shareView struct {
	store.Share
	Items       []shareItemView `json:"items"`
	HasPassword bool            `json:"hasPassword"`
	Exists      bool            `json:"exists"`
}

func (s *Server) viewOf(sh store.Share) (shareView, error) {
	view := shareView{Share: sh, HasPassword: sh.PasswordHash != "", Items: []shareItemView{}}
	for _, item := range sh.Items {
		_, err := s.vault.Stat(item.Path)
		if err != nil && !errors.Is(err, vault.ErrNotFound) {
			return view, err
		}
		exists := err == nil
		view.Exists = view.Exists || exists
		view.Items = append(view.Items, shareItemView{ShareItem: item, Exists: exists})
	}
	return view, nil
}

// listShares 列出全部分享；带 ?path= 时只列出该笔记的
func (s *Server) listShares(w http.ResponseWriter, r *http.Request) {
	all, err := s.store.Shares()
	if err != nil {
		internalError(w, r, err)
		return
	}
	filter := r.URL.Query().Get("path")
	out := []shareView{}
	for _, sh := range all {
		matches := filter == ""
		for _, item := range sh.Items {
			if item.Path == filter {
				matches = true
			}
		}
		if matches {
			view, err := s.viewOf(sh)
			if err != nil {
				vaultError(w, r, err)
				return
			}
			out = append(out, view)
		}
	}
	writeJSON(w, 200, map[string]any{"shares": out})
}

func (s *Server) createShare(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path     string
		Paths    []string
		Password string
		// 有效时长（秒），0 为永久
		ExpiresIn int64
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Path != "" && len(body.Paths) != 0 {
		writeError(w, 400, "path 和 paths 不能同时指定")
		return
	}
	paths := body.Paths
	if body.Path != "" {
		paths = []string{body.Path}
	}
	if len(paths) == 0 {
		writeError(w, 400, "请选择分享主体")
		return
	}
	sort.Strings(paths)
	roots := map[string]bool{}
	items := []store.ShareItem{}
	for _, p := range paths {
		if _, err := vault.CleanPath(p); err != nil {
			writeError(w, 400, "分享路径无效")
			return
		}
		if _, err := s.vault.Stat(p); err != nil {
			vaultError(w, r, err)
			return
		}
		covered := roots[p]
		for parent := path.Dir(p); parent != "."; parent = path.Dir(parent) {
			if roots[parent] {
				covered = true
				break
			}
		}
		if !covered {
			roots[p] = true
			items = append(items, store.ShareItem{ID: len(items), Path: p})
		}
	}
	if body.ExpiresIn < 0 {
		writeError(w, 400, "有效期无效")
		return
	}
	now := time.Now()
	sh := store.Share{
		Token:        auth.NewShareToken(),
		Items:        items,
		PasswordHash: auth.HashSharePassword(body.Password),
		CreatedAt:    now.UnixMilli(),
	}
	if body.ExpiresIn > 0 {
		sh.ExpiresAt = now.Add(time.Duration(body.ExpiresIn) * time.Second).UnixMilli()
	}
	if err := s.store.CreateShare(sh); err != nil {
		internalError(w, r, err)
		return
	}
	if len(sh.Items) == 1 {
		sh.Path = sh.Items[0].Path
	}
	view, err := s.viewOf(sh)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, view)
}

func (s *Server) deleteShare(w http.ResponseWriter, r *http.Request) {
	ok, err := s.store.DeleteShare(r.PathValue("token"))
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !ok {
		writeError(w, 404, "分享不存在")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---- 公开访问（无需登录） ----

// openShare 取出有效的分享并校验访客凭据；失败时已写好响应
func (s *Server) openShare(w http.ResponseWriter, r *http.Request) (store.Share, bool) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex")
	sh, ok, err := s.loadShare(r.PathValue("token"))
	if err != nil {
		internalError(w, r, err)
		return sh, false
	}
	if !ok {
		writeError(w, 404, "分享不存在或已失效")
		return sh, false
	}
	if sh.PasswordHash != "" {
		valid := false
		if c, err := r.Cookie(shareCookieName); err == nil {
			if valid, err = s.auth.ValidShareCookie(c.Value, sh.Token, sh.PasswordHash); err != nil {
				internalError(w, r, err)
				return sh, false
			}
		}
		if !valid {
			writeJSON(w, 401, map[string]any{"error": "需要访问密码", "passwordRequired": true})
			return sh, false
		}
	}
	return sh, true
}

// loadShare 返回未过期的分享
func (s *Server) loadShare(token string) (store.Share, bool, error) {
	sh, ok, err := s.store.GetShare(token)
	if err != nil || !ok {
		return sh, false, err
	}
	if sh.ExpiresAt != 0 && time.Now().UnixMilli() >= sh.ExpiresAt {
		return sh, false, nil
	}
	return sh, true, nil
}

// publicShare 只公开主体本身或分享目录内的内容，不返回主体在仓库中的路径。
func (s *Server) publicShare(w http.ResponseWriter, r *http.Request) {
	sh, ok := s.openShare(w, r)
	if !ok {
		return
	}
	if len(sh.Items) > 1 && r.URL.Query().Get("item") == "" {
		if r.URL.Query().Get("path") != "" {
			writeError(w, 400, "请选择分享主体")
			return
		}
		items := []map[string]any{}
		for _, item := range sh.Items {
			info, err := s.vault.Stat(item.Path)
			if err != nil && !errors.Is(err, vault.ErrNotFound) {
				vaultError(w, r, err)
				return
			}
			items = append(items, map[string]any{"id": item.ID, "title": path.Base(item.Path), "exists": err == nil, "dir": err == nil && info.IsDir()})
		}
		writeJSON(w, 200, map[string]any{"title": "分享的文件", "collection": true, "items": items})
		return
	}
	subject, ok := shareSubject(w, r, sh)
	if !ok {
		return
	}
	info, err := s.vault.Stat(subject)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	p := subject
	if rel := r.URL.Query().Get("path"); rel != "" {
		if !info.IsDir() {
			writeError(w, 404, "文件不存在")
			return
		}
		p, err = s.vault.ScopedPath(subject, rel)
		if err == nil {
			info, err = s.vault.Stat(p)
		}
		if err != nil {
			vaultError(w, r, err)
			return
		}
	}
	if info.IsDir() {
		entries, err := s.vault.TreeAt(p)
		if err != nil {
			vaultError(w, r, err)
			return
		}
		writeJSON(w, 200, map[string]any{"title": path.Base(p), "dir": true, "entries": entries})
		return
	}
	if !vault.IsNote(p) {
		writeJSON(w, 200, map[string]any{"title": path.Base(p), "dir": false})
		return
	}
	data, _, err := s.vault.Read(p)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{
		"title":     strings.TrimSuffix(path.Base(p), vault.NoteExt),
		"content":   string(data),
		"updatedAt": info.ModTime().UnixMilli(),
		"dir":       false,
	})
}

func (s *Server) unlockShare(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var body struct{ Password string }
	if !readJSON(w, r, &body) {
		return
	}
	sh, ok, err := s.loadShare(r.PathValue("token"))
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !ok {
		writeError(w, 404, "分享不存在或已失效")
		return
	}
	if sh.PasswordHash != "" {
		switch err := s.auth.CheckSharePassword(clientIP(r), sh.PasswordHash, body.Password); {
		case errors.Is(err, auth.ErrRateLimited):
			writeError(w, 429, err.Error())
			return
		case errors.Is(err, auth.ErrBadCredentials):
			writeError(w, 401, "密码错误")
			return
		case err != nil:
			internalError(w, r, err)
			return
		}
	}
	value, err := s.auth.ShareCookie(sh.Token, sh.PasswordHash)
	if err != nil {
		internalError(w, r, err)
		return
	}
	ttl := shareCookieTTL
	if sh.ExpiresAt != 0 {
		ttl = time.Until(time.UnixMilli(sh.ExpiresAt))
	}
	http.SetCookie(w, &http.Cookie{
		Name:  shareCookieName,
		Value: value,
		// 默认 Path 为 /unlock 所在目录，避免非 ASCII 文件名违反 Cookie Path 格式。
		MaxAge:   int(ttl / time.Second),
		HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// publicShareAsset 提供主体允许范围内的普通文件；单文件分享额外允许其 .assets。
func (s *Server) publicShareAsset(w http.ResponseWriter, r *http.Request) {
	sh, ok := s.openShare(w, r)
	if !ok {
		return
	}
	subject, ok := shareSubject(w, r, sh)
	if !ok {
		return
	}
	info, err := s.vault.Stat(subject)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	rel := r.PathValue("path")
	var target string
	if info.IsDir() {
		target, err = s.vault.ScopedPath(subject, rel)
	} else if rel == "" {
		target = subject
	} else {
		assets := vault.AssetsDir(subject)
		prefix := path.Base(assets) + "/"
		if !vault.IsNote(subject) || !strings.HasPrefix(rel, prefix) {
			writeError(w, 404, "文件不存在")
			return
		}
		target, err = s.vault.ScopedPath(assets, strings.TrimPrefix(rel, prefix))
	}
	if err != nil {
		vaultError(w, r, err)
		return
	}
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(target)}))
	}
	s.serveRaw(w, r, target)
}

func shareSubject(w http.ResponseWriter, r *http.Request, sh store.Share) (string, bool) {
	raw := r.URL.Query().Get("item")
	if raw == "" && len(sh.Items) == 1 {
		return sh.Items[0].Path, true
	}
	id, err := strconv.Atoi(raw)
	if err == nil {
		for _, item := range sh.Items {
			if item.ID == id {
				return item.Path, true
			}
		}
	}
	writeError(w, 404, "分享主体不存在")
	return "", false
}

// FollowMoves 让分享跟随在外部（如 Typora）完成的改名与移动；经 API 的移动已在 move 接口中处理，
// 这里再次处理时原路径已无分享，不会重复修改
func (s *Server) FollowMoves(ctx context.Context) {
	for ctx.Err() == nil {
		ch, cancel := s.hub.Subscribe()
		s.followMoves(ctx, ch)
		cancel()
	}
}

func (s *Server) followMoves(ctx context.Context, ch <-chan []byte) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				// 处理不及时被断开，重新订阅
				return
			}
			var evs []events.Event
			if err := json.Unmarshal(msg, &evs); err != nil {
				slog.Error("解析变更事件失败", "err", err)
				continue
			}
			for _, ev := range evs {
				if ev.Type == "moved" {
					if err := s.store.MoveShares(ev.From, ev.Path); err != nil {
						slog.Warn("更新分享路径失败", "from", ev.From, "to", ev.Path, "err", err)
					}
				}
			}
		}
	}
}
