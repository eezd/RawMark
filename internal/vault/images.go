package vault

import (
	"bytes"
	"errors"
	"fmt"
	"html"
	"io"
	"io/fs"
	"net/url"
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

type imageLinkChange struct {
	path          string
	before, after []byte
}

// 调用方持有写锁；所有原始内容留到移动成功，以便复合操作失败时回滚。
func (v *Vault) imageLinkChanges(from, to string) ([]imageLinkChange, error) {
	entries, err := v.Tree()
	if err != nil {
		return nil, err
	}
	var changes []imageLinkChange
	for _, e := range entries {
		if e.Dir || !IsNote(e.Path) {
			continue
		}
		p := filepath.Join(v.root, filepath.FromSlash(e.Path))
		before, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		after, err := rewriteImageLinks(before, e.Path, from, to)
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(before, after) {
			changes = append(changes, imageLinkChange{p, before, after})
		}
	}
	return changes, nil
}

func rewriteImageLinks(content []byte, note, from, to string) ([]byte, error) {
	rel, err := filepath.Rel(filepath.FromSlash(path.Dir(note)), filepath.FromSlash(to))
	if err != nil {
		return nil, err
	}
	spans := importLinkSpans(content)
	var out []byte
	last := 0
	for _, span := range spans {
		if span.start < last {
			continue
		}
		target := string(content[span.start:span.end])
		if span.html {
			target = html.UnescapeString(target)
		} else {
			target = markdownEscape.ReplaceAllString(target, "$1")
		}
		u, err := url.Parse(target)
		if err != nil || u.IsAbs() || u.Host != "" || strings.HasPrefix(target, "/") || u.Path == "" || path.Clean(path.Join(path.Dir(note), u.Path)) != from {
			continue
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
