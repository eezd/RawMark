// Package web 把前端构建产物（web/dist，由 npm run build 生成）嵌入 Go 二进制。
package web

import (
	"embed"
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
