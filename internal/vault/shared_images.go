package vault

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type imageTransfer struct {
	source, target string
	data           []byte
	created        bool
	removeSource   bool
	removed        bool
}

// 调用方持有写锁，并在后续笔记移动失败时撤回新副本。
// 旧的独立附件仍由 Move 连同目录移动；共享图片只在其他笔记不再引用时移走原件。
func (v *Vault) copyNoteImages(from, to string) (transfers []imageTransfer, targets map[string]string, err error) {
	content, _, err := v.Read(from)
	if err != nil {
		return nil, nil, err
	}
	metadata := Analyze(from, content)
	if len(metadata.Warnings) != 0 {
		return nil, nil, fmt.Errorf("%w：%s 的元数据异常，无法确认图片引用", ErrInvalidPath, from)
	}
	entries, err := v.Tree()
	if err != nil {
		return nil, nil, err
	}
	used := map[string]bool{}
	for _, entry := range entries {
		if entry.Dir || !IsNote(entry.Path) || entry.Path == from {
			continue
		}
		body, _, e := v.Read(entry.Path)
		if e != nil {
			return nil, nil, e
		}
		m := Analyze(entry.Path, body)
		if len(m.Warnings) != 0 {
			return nil, nil, fmt.Errorf("%w：%s 的元数据异常，无法确认图片引用", ErrInvalidPath, entry.Path)
		}
		for _, ref := range m.Assets {
			used[ref.Target] = true
		}
	}
	targets = map[string]string{}
	for _, ref := range metadata.Assets {
		if !IsImage(ref.Target) || strings.HasPrefix(ref.Target, AssetsDir(from)+"/") {
			continue
		}
		if _, seen := targets[ref.Target]; seen {
			continue
		}
		source, e := v.abs(ref.Target)
		if e != nil {
			return transfers, targets, e
		}
		info, e := os.Lstat(source)
		if os.IsNotExist(e) {
			continue // 已缺失的图片保留链接，由缺失检查报告。
		}
		if e != nil {
			return transfers, targets, e
		}
		if !info.Mode().IsRegular() {
			return transfers, targets, ErrInvalidPath
		}
		data, e := os.ReadFile(source)
		if e != nil {
			return transfers, targets, e
		}
		dest, exists, e := v.assetDestination(path.Join(path.Dir(to), "assets"), path.Base(ref.Target), data)
		if e != nil {
			return transfers, targets, e
		}
		targets[ref.Target] = dest
		transfer := imageTransfer{source: ref.Target, target: dest, data: data, removeSource: !used[ref.Target] && ref.Target != dest}
		if !exists {
			full := filepath.Join(v.root, filepath.FromSlash(dest))
			if e := os.MkdirAll(filepath.Dir(full), 0o755); e != nil {
				return transfers, targets, e
			}
			if e := atomicWrite(full, data); e != nil {
				return transfers, targets, e
			}
			transfer.created = true
		}
		transfers = append(transfers, transfer)
	}
	return transfers, targets, nil
}
