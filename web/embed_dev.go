//go:build dev

package web

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
)

// Dist 在开发模式下直接读取磁盘上的 web/dist（未构建时为空，页面由 Vite 开发服务器提供），
// 因此无需先构建前端即可 go run
func Dist() fs.FS {
	return os.DirFS("web/dist")
}

// 开发环境由 Vite 提供页面，不依赖 web/dist 中可能过期的构建产物。
func BuildVersion() (string, error) { return "dev", nil }

// FontStorage 按 Vite 构建使用的 fonts.css 统计可选字体，不包含 Maple 与 KaTeX。
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
