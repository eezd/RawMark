package api

import (
	"errors"
	"net/http"

	"rawmark/internal/vault"
)

func (s *Server) importNotes(w http.ResponseWriter, r *http.Request) {
	// 总请求上限包含表单开销，文件总量另由 vault 校验。
	r.Body = http.MaxBytesReader(w, r.Body, vault.MaxImportBytes+(1<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			writeError(w, 413, "导入文件总量不能超过 100 MB")
		} else {
			writeError(w, 400, "无法读取导入表单")
		}
		return
	}
	defer r.MultipartForm.RemoveAll()
	headers := r.MultipartForm.File["files"]
	if len(headers) == 0 || len(headers) > 10_000 {
		writeError(w, 400, "请选择 Markdown 文件或一个 ZIP")
		return
	}
	files := make([]vault.ImportFile, 0, len(headers))
	for _, h := range headers {
		f, err := h.Open()
		if err != nil {
			internalError(w, r, err)
			return
		}
		defer f.Close()
		files = append(files, vault.ImportFile{Name: h.Filename, Reader: f, Size: h.Size})
	}
	result, err := s.vault.Import(r.Context(), r.FormValue("dir"), r.FormValue("folder"), files)
	if err != nil {
		vaultError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}
