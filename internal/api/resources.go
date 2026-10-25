package api

import (
	"net/http"
	"strings"
	"time"

	"rawmark/internal/store"
	"rawmark/internal/vault"
)

func (s *Server) createTicket(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind     string `json:"kind"`
		PluginID string `json:"pluginId"`
		Revision string `json:"revision"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	p := identity(r)
	t := store.ResourceTicket{SessionHash: p.SessionHash, Kind: body.Kind, ExpiresAt: p.ExpiresAt}
	suffix := body.Kind + "/"
	switch body.Kind {
	case "images", "fonts":
		if body.PluginID != "" || body.Revision != "" {
			writeError(w, 400, "资源票据范围无效")
			return
		}
	case "events":
		t.ExpiresAt = time.Now().Add(time.Minute)
		if t.ExpiresAt.After(p.ExpiresAt) {
			t.ExpiresAt = p.ExpiresAt
		}
	case "plugin":
		dir, info, err := s.openPlugin(body.PluginID)
		if err != nil {
			s.pluginError(w, r, err)
			return
		}
		dir.Close()
		if info.Revision != body.Revision {
			writeError(w, 409, "插件版本已改变，请刷新")
			return
		}
		t.Resource, t.Revision = body.PluginID, body.Revision
		suffix = "plugins/" + body.PluginID + "/assets/" + body.Revision + "/"
	default:
		writeError(w, 400, "资源票据用途无效")
		return
	}
	plain := opaqueToken()
	t.Hash = tokenHash(plain)
	if err := s.store.CreateTicket(t); err != nil {
		internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"url": "/api/v1/resources/" + plain + "/" + suffix, "expiresAt": t.ExpiresAt})
}

func (s *Server) resource(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	t, ok, err := s.store.Ticket(tokenHash(r.PathValue("ticket")), kind == "events", time.Now())
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !ok {
		writeError(w, 401, "资源票据已失效")
		return
	}
	parent := principal{SessionHash: t.SessionHash, ExpiresAt: t.ExpiresAt}
	valid, err := s.validPrincipal(parent)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if !valid {
		writeError(w, 401, "登录已失效")
		return
	}
	r = withIdentity(r, parent)
	name := r.PathValue("path")
	switch {
	case kind == "images" && t.Kind == "images":
		if !vault.IsImage(name) {
			writeError(w, 403, "票据仅允许读取图片")
			return
		}
		s.raw(w, r)
	case kind == "fonts" && t.Kind == "fonts":
		id, ok := strings.CutSuffix(name, "/file")
		if !ok || strings.Contains(id, "/") {
			writeError(w, 403, "字体票据范围不匹配")
			return
		}
		r.SetPathValue("id", id)
		s.fontFile(w, r)
	case kind == "plugins" && t.Kind == "plugin":
		parts := strings.SplitN(name, "/", 4)
		if len(parts) != 4 || parts[0] != t.Resource || parts[1] != "assets" || parts[2] != t.Revision {
			writeError(w, 403, "插件票据范围不匹配")
			return
		}
		r.SetPathValue("id", t.Resource)
		r.SetPathValue("revision", t.Revision)
		r.SetPathValue("path", parts[3])
		s.pluginAsset(w, r)
	case kind == "events" && t.Kind == "events" && name == "":
		s.events(w, r)
	default:
		writeError(w, 403, "资源票据用途不匹配")
	}
}
