package api

import "net/http"
import "rawmark/internal/i18n"

func (s *Server) cleanupImages(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.Paths) == 0 || len(body.Paths) > 1000 {
		writeError(w, 400, message(w, "select_between_and_images_to_338e4e"))
		return
	}
	result, err := s.vault.CleanupImages(body.Paths)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	for i := range result.Skipped {
		result.Skipped[i].Reason = i18n.RenderError(result.Skipped[i].Cause, responseLocale(w))
	}
	writeJSON(w, 200, result)
}
