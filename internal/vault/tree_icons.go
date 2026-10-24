package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// TreeIcon 是文件树的显示属性，不参与 Markdown 内容或版本计算。
type TreeIcon struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

var ErrInvalidIcon = errors.New("非法图标")

const builtinIcons = " plus eye expand graph calendar tag copy task quote undo redo print grid menu noteAdd import folderAdd folder image note chevron more close pin trash logout restore edit search link key settings palette user outline source command info "

var emojiPattern = regexp.MustCompile(`^[\p{So}\p{Sk}\p{Sm}\x{2139}\x{203C}\x{2049}\x{3030}\x{303D}\x{200D}\x{FE0F}\x{20E3}0-9#*\x{E0020}-\x{E007F}]+$`)
var emojiBase = regexp.MustCompile(`[\p{So}\p{Sm}\x{2139}\x{203C}\x{2049}\x{3030}\x{303D}\x{20E3}]`)

func (icon TreeIcon) valid() bool {
	switch icon.Kind {
	case "builtin":
		return icon.Value != "" && !strings.ContainsAny(icon.Value, " \t\r\n") && strings.Contains(builtinIcons, " "+icon.Value+" ")
	case "emoji":
		return utf8.ValidString(icon.Value) && len(icon.Value) <= 64 && emojiPattern.MatchString(icon.Value) && emojiBase.MatchString(icon.Value)
	default:
		return false
	}
}

func (v *Vault) readTreeIcons() (map[string]TreeIcon, error) {
	data, err := os.ReadFile(filepath.Join(v.root, metaDir, "tree-icons.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]TreeIcon{}, nil
	}
	if err != nil {
		return nil, err
	}
	var icons map[string]TreeIcon
	if err := json.Unmarshal(data, &icons); err != nil {
		return nil, fmt.Errorf("文件树图标元数据损坏: %w", err)
	}
	if icons == nil {
		return nil, errors.New("文件树图标元数据必须是对象")
	}
	for p, icon := range icons {
		if _, err := CleanPath(p); err != nil || !icon.valid() {
			return nil, errors.New("文件树图标元数据含非法路径或图标")
		}
	}
	return icons, nil
}

func (v *Vault) writeTreeIcons(icons map[string]TreeIcon) error {
	data, err := json.Marshal(icons)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(v.root, metaDir, "tree-icons.json"), data)
}

func (v *Vault) SetTreeIcon(rel string, icon *TreeIcon) error {
	if icon != nil && !icon.valid() {
		return ErrInvalidIcon
	}
	p, err := v.abs(rel)
	if err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	info, err := os.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !info.IsDir() && (!info.Mode().IsRegular() || (!IsNote(rel) && !IsImage(rel))) {
		return ErrInvalidPath
	}
	icons, err := v.readTreeIcons()
	if err != nil {
		return err
	}
	if icon == nil {
		if _, ok := icons[rel]; !ok {
			return nil
		}
		delete(icons, rel)
	} else {
		if icons[rel] == *icon {
			return nil
		}
		icons[rel] = *icon
	}
	return v.writeTreeIcons(icons)
}

// 从所属子树移出属性，供移动和回收站操作在原有写锁内提交。
func takeTreeIcons(icons map[string]TreeIcon, root string, directory bool) map[string]TreeIcon {
	taken := map[string]TreeIcon{}
	for p, icon := range icons {
		if p == root || directory && strings.HasPrefix(p, root+"/") {
			taken[p] = icon
			delete(icons, p)
		}
	}
	return taken
}

// 回收站保留属性，但普通回收站 API 不暴露内部元数据。
type trashMetadata struct {
	TrashItem
	Icons map[string]TreeIcon `json:"icons,omitempty"`
}
