//go:build !dev

package web

import (
	"encoding/json"
	"io/fs"
)

// FontStorage 读取构建工具统计的内置可选字体大小，不包含默认 Maple。
func FontStorage() (int64, error) {
	data, err := fs.ReadFile(Dist(), "font-storage.json")
	if err != nil {
		return 0, err
	}
	var sizes struct {
		OptionalFontsSize int64 `json:"optionalFontsSize"`
	}
	if err := json.Unmarshal(data, &sizes); err != nil {
		return 0, err
	}
	return sizes.OptionalFontsSize, nil
}
