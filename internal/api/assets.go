package api

import (
	"net/http"
	"time"
)

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
	result, err := s.vault.CleanupImages(body.Paths, func() ([]string, error) {
		shares, err := s.store.Shares()
		if err != nil {
			return nil, err
		}
		scopes := []string{}
		now := time.Now().Unix()
		for _, share := range shares {
			if share.ExpiresAt != 0 && share.ExpiresAt <= now {
				continue
			}
			for _, item := range share.Items {
				scopes = append(scopes, item.Path)
			}
		}
		return scopes, nil
	})
	if err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, 200, result)
}
