package api

import (
	"mime"
	"net/http"
	"os"
	"strings"
	"time"
)

func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	file, name, err := s.vault.Export(r.Context(), body.Paths)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	defer file.Close()
	defer os.Remove(file.Name())
	contentType := "application/zip"
	if strings.HasSuffix(name, ".md") {
		contentType = "text/markdown; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	http.ServeContent(w, r, name, time.Time{}, file)
}
