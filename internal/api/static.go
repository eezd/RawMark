package api

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"
)

// Application CSP: CodeMirror injects <style> elements and requires 'unsafe-inline';
// notes may reference external images, so img-src allows http/https.
const appCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob: https: http:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; " +
	"object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

type staticFile struct {
	data    []byte
	gzipped []byte // nil when compression does not reduce size.
}

// staticHandler serves frontend builds: hashed assets/ files use long-lived caching; other files revalidate on every request.
// Text resources are compressed and cached in memory on first request (embedded files never change).
type staticHandler struct {
	fsys    fs.FS
	started time.Time
	mu      sync.Mutex
	cache   map[string]*staticFile
}

func newStaticHandler(fsys fs.FS) http.Handler {
	return &staticHandler{fsys: fsys, started: time.Now(), cache: map[string]*staticFile{}}
}

func (h *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, 405, message(w, "unsupported_request_method_bc2f08"))
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	// Removed public entry points must not fall back to the application home page.
	if name == "s" || strings.HasPrefix(name, "s/") || name == "share.html" {
		writeError(w, 404, message(w, "page_not_found_e75737"))
		return
	}
	f, err := h.load(name)
	if err != nil {
		// Frontend routing: unknown paths return the entry page.
		name = "index.html"
		if f, err = h.load(name); err != nil {
			writeError(w, 404, message(w, "frontend_resources_are_missing_2c9b3e"))
			return
		}
	}
	hd := w.Header()
	if strings.HasPrefix(name, "assets/") {
		hd.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		hd.Set("Cache-Control", "no-cache")
	}
	if strings.HasSuffix(name, ".html") {
		hd.Set("Content-Security-Policy", appCSP)
	}
	if path.Ext(name) == ".webmanifest" {
		// Go's MIME table may lack this extension; do not let ServeContent sniff the compressed bytes.
		hd.Set("Content-Type", "application/manifest+json")
	} else if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		hd.Set("Content-Type", ct)
	}
	hd.Add("Vary", "Accept-Encoding")
	body := f.data
	if f.gzipped != nil && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		hd.Set("Content-Encoding", "gzip")
		body = f.gzipped
	}
	http.ServeContent(w, r, name, h.started, bytes.NewReader(body))
}

func (h *staticHandler) load(name string) (*staticFile, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if f, ok := h.cache[name]; ok {
		return f, nil
	}
	data, err := fs.ReadFile(h.fsys, name)
	if err != nil {
		return nil, err
	}
	f := &staticFile{data: data}
	switch path.Ext(name) {
	case ".js", ".css", ".html", ".svg", ".json", ".txt", ".webmanifest":
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		zw.Write(data)
		zw.Close()
		if buf.Len() < len(data) {
			f.gzipped = buf.Bytes()
		}
	}
	h.cache[name] = f
	return f, nil
}
