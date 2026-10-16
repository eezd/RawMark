//go:build dev

package web

import (
	"io/fs"
	"os"
)

// Dist 在开发模式下直接读取磁盘上的 web/dist（未构建时为空，页面由 Vite 开发服务器提供），
// 因此无需先构建前端即可 go run
func Dist() fs.FS {
	return os.DirFS("web/dist")
}
