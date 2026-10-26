package vault

import (
	"bytes"
	"errors"
	"html"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"rawmark/internal/i18n"
	"strings"
)

// ReplaceImage 原位替换已有图片，保留所有引用路径；不允许借此创建文件或改变格式。
func (v *Vault) ReplaceImage(rel, filename string, r io.Reader, limit int64) error {
	if !IsImage(rel) || !strings.EqualFold(path.Ext(rel), path.Ext(filename)) {
		return i18n.New("w_choose_a_file_with_8410e9", ErrInvalidPath)
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
		return i18n.New("w_image_cannot_be_empty_a9a272", ErrInvalidPath)
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
func (v *Vault) moveLinkChanges(from, to string, directory bool, ownAssets bool, images map[string]string) ([]linkChange, error) {
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
		after, err := rewriteLocalLinks(before, entry.Path, next, func(target string) string {
			if entry.Path == from {
				if image, ok := images[target]; ok {
					return image
				}
			}
			mapped := movedPath(target, from, to, directory)
			if ownAssets {
				mapped = movedPath(mapped, AssetsDir(from), AssetsDir(to), true)
			}
			return mapped
		})
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

// 只替换链接地址，不重新序列化正文；移动和图片归位共用相同的代码/公式边界。
func rewriteLocalLinks(content []byte, oldNote, newNote string, mapTarget func(string) string) ([]byte, error) {
	var out []byte
	last := 0
	excluded := nonProseRanges(parseMetadata(content))
	for _, span := range importLinkSpans(content) {
		skip := false
		for _, region := range excluded {
			if span.start >= region[0] && span.start < region[1] {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		if span.start < last {
			continue
		}
		target, u, ok := LocalTarget(oldNote, string(content[span.start:span.end]))
		if !ok {
			continue
		}
		mapped := mapTarget(target)
		if mapped == target && path.Dir(oldNote) == path.Dir(newNote) {
			continue
		}
		rel, err := filepath.Rel(filepath.FromSlash(path.Dir(newNote)), filepath.FromSlash(mapped))
		if err != nil {
			return nil, err
		}
		replacement := EscapeLinkPath(filepath.ToSlash(rel))
		if strings.HasPrefix(replacement, "assets/") {
			replacement = "./" + replacement
		}
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
