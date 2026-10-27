package fileutil

import (
	"path/filepath"
	"runtime"
	"strings"
)

// IsLocalPath also rejects Windows aliases and invalid native filename characters.
func IsLocalPath(name string) bool {
	if !filepath.IsLocal(name) {
		return false
	}
	if runtime.GOOS == "windows" {
		if strings.ContainsAny(name, `<>:"\|?*`) {
			return false
		}
		for _, c := range name {
			if c < 32 {
				return false
			}
		}
		for _, part := range strings.Split(name, "/") {
			if strings.HasSuffix(part, " ") || strings.HasSuffix(part, ".") {
				return false
			}
		}
	}
	return true
}
