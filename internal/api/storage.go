package api

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

type storageCategory struct {
	ID   string `json:"id"`
	Size int64  `json:"size"`
}

type storageUsage struct {
	TotalSize        int64             `json:"totalSize"`
	Categories       []storageCategory `json:"categories"`
	AssetsSize       int64             `json:"assetsSize"`
	TrashSize        int64             `json:"trashSize"`
	BuiltinFontsSize int64             `json:"builtinFontsSize"`
	CustomFontsSize  int64             `json:"customFontsSize"`
	CalculatedAt     int64             `json:"calculatedAt"`
}

func (s *Server) getStorage(w http.ResponseWriter, r *http.Request) {
	usage, err := scanStorage(r.Context(), s.DataDir, s.vault.Root())
	if err != nil {
		internalError(w, r, err)
		return
	}
	usage.BuiltinFontsSize = s.BuiltinFontsSize
	usage.CustomFontsSize = usage.Categories[2].Size
	usage.Categories[2].Size += s.BuiltinFontsSize
	usage.TotalSize += s.BuiltinFontsSize
	writeJSON(w, http.StatusOK, usage)
}

// 只统计普通文件逻辑字节，不跟随内部符号链接；外置仓库单独扫描。
// 两个根互相嵌套时，各自由更具体的根负责，避免重复计算。
func scanStorage(ctx context.Context, dataDir, vaultDir string) (storageUsage, error) {
	usage := storageUsage{Categories: []storageCategory{{ID: "vault"}, {ID: "databases"}, {ID: "fonts"}, {ID: "themes"}, {ID: "plugins"}, {ID: "other"}}}
	if dataDir == "" {
		return usage, fmt.Errorf("未配置应用数据目录")
	}
	dataRoot, err := filepath.EvalSymlinks(dataDir)
	if err != nil {
		return usage, err
	}
	dataRoot, err = filepath.Abs(dataRoot)
	if err != nil {
		return usage, err
	}
	vaultRoot, err := filepath.Abs(vaultDir)
	if err != nil {
		return usage, err
	}
	appCategory := func(rel string) int {
		top := strings.Split(filepath.ToSlash(rel), "/")[0]
		switch top {
		case "rawmark.db", "rawmark.db-wal", "rawmark.db-shm", "index.db", "index.db-wal", "index.db-shm":
			return 1
		case "fonts":
			return 2
		case "themes":
			return 3
		case "plugins":
			return 4
		default:
			return 5
		}
	}
	walk := func(root, skip string, isVault bool) error {
		return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if walkErr != nil {
				if path != root && errors.Is(walkErr, fs.ErrNotExist) {
					return nil // 文件可能在扫描期间被移动或删除。
				}
				return walkErr
			}
			if path != root && path == skip && entry.IsDir() {
				return filepath.SkipDir
			}
			if entry.IsDir() || entry.Type()&fs.ModeSymlink != 0 {
				return nil
			}
			info, err := entry.Info()
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			category := 0
			if !isVault || dataRoot == vaultRoot {
				category = appCategory(rel)
				if isVault && category == 5 {
					category = 0
				}
			}
			size := info.Size()
			usage.TotalSize += size
			usage.Categories[category].Size += size
			if category == 0 {
				parts := strings.Split(filepath.ToSlash(rel), "/")
				if len(parts) >= 3 && parts[0] == ".rawmark" && parts[1] == "trash" {
					usage.TrashSize += size
				} else {
					for _, part := range parts[:len(parts)-1] {
						if part == "assets" || strings.HasSuffix(part, ".assets") {
							usage.AssetsSize += size
							break
						}
					}
				}
			}
			return nil
		})
	}
	if dataRoot != vaultRoot {
		if err := walk(dataRoot, vaultRoot, false); err != nil {
			return storageUsage{}, err
		}
	}
	if err := walk(vaultRoot, dataRoot, true); err != nil {
		return storageUsage{}, err
	}
	usage.CalculatedAt = time.Now().UnixMilli()
	return usage, nil
}
