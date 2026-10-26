package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"rawmark/internal/i18n"

	"rawmark/internal/auth"
	"rawmark/internal/events"
)

// 应用设置：一份 JSON 对象，全部设备共用。内容由前端定义，服务端合并与保存，并校验由服务端执行的清理期限
const settingsKey = "app.settings"

func (s *Server) readSettings() (map[string]json.RawMessage, error) {
	v, ok, err := s.store.Setting(settingsKey)
	if err != nil || !ok {
		return map[string]json.RawMessage{}, err
	}
	out := map[string]json.RawMessage{}
	return out, json.Unmarshal([]byte(v), &out)
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.readSettings()
	if err != nil {
		internalError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, settings)
}

// patchSettings 按顶层键合并：请求中的键覆盖原值，值为 null 的键被删除。
// 不同设备同时修改不同的设置不会互相覆盖；合并后通知其他设备重新读取
func (s *Server) patchSettings(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxJSONBytes))
	if err != nil {
		writeError(w, 413, message(w, "settings_are_too_large_8a580f"))
		return
	}
	var patch map[string]json.RawMessage
	if err := json.Unmarshal(data, &patch); err != nil || patch == nil {
		writeError(w, 400, message(w, "settings_must_be_a_json_45b36b"))
		return
	}
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	settings, err := s.readSettings()
	if err != nil {
		internalError(w, r, err)
		return
	}
	for k, v := range patch {
		if bytes.Equal(v, []byte("null")) {
			delete(settings, k)
		} else {
			settings[k] = v
		}
	}
	if err := validateLocale(settings); err != nil {
		writeError(w, 400, i18n.RenderError(err, responseLocale(w)))
		return
	}
	if _, err := trashRetentionDays(settings); err != nil {
		writeError(w, 400, i18n.RenderError(err, responseLocale(w)))
		return
	}
	merged, err := json.Marshal(settings)
	if err != nil {
		internalError(w, r, err)
		return
	}
	if len(merged) > maxJSONBytes {
		writeError(w, 413, message(w, "settings_are_too_large_8a580f"))
		return
	}
	if err := s.store.SetSetting(settingsKey, string(merged)); err != nil {
		internalError(w, r, err)
		return
	}
	s.hub.Broadcast(events.Event{Type: "settings"})
	writeJSON(w, 200, settings)
}

// changePassword 修改登录密码；当前会话保留，其他设备需重新登录
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var body struct{ Current, Next string }
	if !readJSON(w, r, &body) {
		return
	}
	switch err := s.auth.ChangePassword(clientIP(r), identity(r).Token, body.Current, body.Next); {
	case errors.Is(err, auth.ErrRateLimited):
		writeError(w, 429, i18n.RenderError(err, responseLocale(w)))
	case errors.Is(err, auth.ErrBadCredentials):
		writeFailure(w, 400, CodeCurrentPassword, message(w, "current_password_is_incorrect_e0f0aa"), nil)
	case errors.Is(err, auth.ErrWeakPassword):
		writeError(w, 400, i18n.RenderError(err, responseLocale(w)))
	case err != nil:
		internalError(w, r, err)
	default:
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}
