package api

import (
	"encoding/json"
	"net/http"
	"strings"
)

const (
	CodeCaptchaInvalid  = 40001
	CodeCaptchaExpired  = 40002
	CodeCurrentPassword = 40003
	CodeBadCredentials  = 40101
	CodeConflict        = 41200
)

type response struct {
	Code    int    `json:"code"`
	Data    any    `json:"data"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	writeResponse(w, status, response{Code: 0, Data: v, Message: message(w, "success")})
}
func writeFailure(w http.ResponseWriter, status, code int, message string, data any) {
	writeResponse(w, status, response{Code: code, Data: data, Message: message})
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeFailure(w, status, status*100, message, nil)
}
func writeResponse(w http.ResponseWriter, status int, value response) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func logPath(value string) string {
	const prefix = "/api/v1/resources/"
	if strings.HasPrefix(value, prefix) {
		_, rest, _ := strings.Cut(strings.TrimPrefix(value, prefix), "/")
		return prefix + "[redacted]/" + rest
	}
	return value
}
