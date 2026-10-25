//go:build !dev

// Package web 把前端构建产物（web/dist，由 npm run build 生成）嵌入 Go 二进制。
// 开发时使用 -tags dev，前端由 Vite 开发服务器提供，见 embed_dev.go。
package web

import (
	"bytes"
	"embed"
	"fmt"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

func Dist() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // 路径为编译期常量，不会失败
	}
	return sub
}

// BuildVersion 与页面入口使用同一构建标识，生产产物缺失时明确失败。
func BuildVersion() (string, error) {
	html, err := fs.ReadFile(Dist(), "index.html")
	if err != nil {
		return "", err
	}
	marker := []byte(`<meta name="rawmark-version" content="`)
	if start := bytes.Index(html, marker); start >= 0 {
		rest := html[start+len(marker):]
		if end := bytes.IndexByte(rest, '"'); end > 0 {
			return string(rest[:end]), nil
		}
	}
	return "", fmt.Errorf("缺少构建版本")
}
