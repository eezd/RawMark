package api

import "net/http"

func (s *Server) cleanupImages(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.Paths) == 0 || len(body.Paths) > 1000 {
		writeError(w, 400, "请选择 1～1000 张待清理图片")
		return
	}
	result, err := s.vault.CleanupImages(body.Paths)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, result)
}
