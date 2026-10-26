//go:build dev

package web

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
)

// Dist reads web/dist from disk in development (empty before building; Vite serves pages),
// so go run does not require a frontend build first.
func Dist() fs.FS {
	return os.DirFS("web/dist")
}

// Vite serves development pages without relying on potentially stale web/dist output.
func BuildVersion() (string, error) { return "dev", nil }

// FontStorage counts optional fonts from fonts.css as used by Vite, excluding Maple and KaTeX.
func FontStorage() (int64, error) {
	root := filepath.Join("web", "src", "common", "appearance")
	css, err := os.ReadFile(filepath.Join(root, "fonts.css"))
	if err != nil {
		return 0, err
	}
	paths := regexp.MustCompile(`url\(['"]?(\.?/?fonts/[^)'"]+)`).FindAllSubmatch(css, -1)
	seen := map[string]bool{}
	var size int64
	for _, match := range paths {
		name := string(match[1])
		if seen[name] {
			continue
		}
		seen[name] = true
		info, err := os.Stat(filepath.Join(root, name))
		if err != nil {
			return 0, err
		}
		size += info.Size()
	}
	return size, nil
}
