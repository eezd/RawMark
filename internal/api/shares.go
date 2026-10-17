package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"path"
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

type shareView struct {
	store.Share
	HasPassword bool `json:"hasPassword"`
	// 笔记是否仍存在（被删除或在外部改名后为 false）
	Exists bool `json:"exists"`
}

func (s *Server) viewOf(sh store.Share) shareView {
	_, err := s.vault.Stat(sh.Path)
	return shareView{Share: sh, HasPassword: sh.PasswordHash != "", Exists: err == nil}
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
		if filter == "" || sh.Path == filter {
			out = append(out, s.viewOf(sh))
		}
	}
	writeJSON(w, 200, map[string]any{"shares": out})
}

func (s *Server) createShare(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path     string
		Password string
		// 有效时长（秒），0 为永久
		ExpiresIn int64
	}
	if !readJSON(w, r, &body) {
		return
	}
	p, err := vault.CleanPath(body.Path)
	if err != nil || !vault.IsNote(p) {
		writeError(w, 400, "只能分享笔记")
		return
	}
	if _, err := s.vault.Stat(p); err != nil {
		vaultError(w, r, err)
		return
	}
	if body.ExpiresIn < 0 {
		writeError(w, 400, "有效期无效")
		return
	}
	now := time.Now()
	sh := store.Share{
		Token:        auth.NewShareToken(),
		Path:         p,
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
	writeJSON(w, 200, s.viewOf(sh))
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

// publicShare 返回笔记标题与当前内容（不含所在目录，避免泄露仓库结构）
func (s *Server) publicShare(w http.ResponseWriter, r *http.Request) {
	sh, ok := s.openShare(w, r)
	if !ok {
		return
	}
	data, _, err := s.vault.Read(sh.Path)
	if errors.Is(err, vault.ErrNotFound) {
		writeError(w, 404, "分享的笔记已不存在")
		return
	}
	if err != nil {
		internalError(w, r, err)
		return
	}
	info, err := s.vault.Stat(sh.Path)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{
		"title":     strings.TrimSuffix(path.Base(sh.Path), vault.NoteExt),
		"content":   string(data),
		"updatedAt": info.ModTime().UnixMilli(),
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
		Name:     shareCookieName,
		Value:    value,
		Path:     "/api/v1/public/shares/" + sh.Token,
		MaxAge:   int(ttl / time.Second),
		HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// publicShareAsset 输出分享笔记中的图片：路径相对笔记所在目录，且只能是该笔记 .assets 目录内的文件
func (s *Server) publicShareAsset(w http.ResponseWriter, r *http.Request) {
	sh, ok := s.openShare(w, r)
	if !ok {
		return
	}
	rel := path.Join(path.Dir(sh.Path), r.PathValue("path"))
	if !strings.HasPrefix(rel, vault.AssetsDir(sh.Path)+"/") {
		writeError(w, 404, "文件不存在")
		return
	}
	s.serveRaw(w, r, rel)
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
