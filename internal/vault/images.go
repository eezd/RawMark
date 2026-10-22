package vault

import (
	"bytes"
	"errors"
	"fmt"
	"html"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// ReplaceImage 原位替换已有图片，保留所有引用路径；不允许借此创建文件或改变格式。
func (v *Vault) ReplaceImage(rel, filename string, r io.Reader, limit int64) error {
	if !IsImage(rel) || !strings.EqualFold(path.Ext(rel), path.Ext(filename)) {
		return fmt.Errorf("%w：请选择与原图片扩展名相同的文件", ErrInvalidPath)
	}
	p, err := v.abs(rel)
	if err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > limit {
		return ErrTooLarge
	}
	if len(data) == 0 {
		return fmt.Errorf("%w：图片不能为空", ErrInvalidPath)
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
	if !info.Mode().IsRegular() {
		return ErrInvalidPath
	}
	return atomicWrite(p, data)
}

type linkChange struct {
	path          string
	before, after []byte
}

// 调用方持有写锁；先计算全部改写，移动成功后再写入，出错时保留回滚依据。
func (v *Vault) moveLinkChanges(from, to string, directory bool, ownAssets bool) ([]linkChange, error) {
	entries, err := v.Tree()
	if err != nil {
		return nil, err
	}
	var changes []linkChange
	for _, entry := range entries {
		if entry.Dir || !IsNote(entry.Path) {
			continue
		}
		before, _, err := v.Read(entry.Path)
		if err != nil {
			return nil, err
		}
		next := movedPath(entry.Path, from, to, directory)
		after, err := rewriteMovedLinks(before, entry.Path, next, from, to, directory, ownAssets)
		if err != nil {
			return nil, err
		}
		if ownAssets && entry.Path == from {
			after = RewriteAssetLinks(after, strings.TrimSuffix(path.Base(from), NoteExt), strings.TrimSuffix(path.Base(to), NoteExt))
		}
		if !bytes.Equal(before, after) {
			changes = append(changes, linkChange{filepath.Join(v.root, filepath.FromSlash(next)), before, after})
		}
	}
	return changes, nil
}

func movedPath(p, from, to string, directory bool) string {
	if p == from {
		return to
	}
	if directory && strings.HasPrefix(p, from+"/") {
		return to + strings.TrimPrefix(p, from)
	}
	return p
}

func rewriteMovedLinks(content []byte, oldNote, newNote, from, to string, directory, ownAssets bool) ([]byte, error) {
	var out []byte
	last := 0
	for _, span := range importLinkSpans(content) {
		if span.start < last {
			continue
		}
		target, u, ok := LocalTarget(oldNote, string(content[span.start:span.end]))
		if !ok {
			continue
		}
		mapped := movedPath(target, from, to, directory)
		if ownAssets {
			mapped = movedPath(mapped, AssetsDir(from), AssetsDir(to), true)
		}
		if mapped == target && path.Dir(oldNote) == path.Dir(newNote) {
			continue
		}
		rel, err := filepath.Rel(filepath.FromSlash(path.Dir(newNote)), filepath.FromSlash(mapped))
		if err != nil {
			return nil, err
		}
		replacement := EscapeLinkPath(filepath.ToSlash(rel))
		if u.RawQuery != "" {
			replacement += "?" + u.RawQuery
		}
		if u.Fragment != "" {
			replacement += "#" + u.EscapedFragment()
		}
		if span.html {
			replacement = html.EscapeString(replacement)
		}
		out = append(out, content[last:span.start]...)
		out = append(out, replacement...)
		last = span.end
	}
	return append(out, content[last:]...), nil
}
