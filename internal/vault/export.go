package vault

import (
	"archive/zip"
	"context"
	"fmt"
	"html"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// Export 在临时文件中完成导出，成功后由调用方关闭并删除文件。
// ZIP 保留仓库相对路径，正文不改写；只导出原始文件，不解析或下载外部资源。
func (v *Vault) Export(ctx context.Context, paths []string) (result *os.File, name string, err error) {
	if len(paths) == 0 {
		return nil, "", fmt.Errorf("%w：请选择导出内容", ErrInvalidPath)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	files := map[string]bool{}
	directory := false
	for _, p := range paths {
		info, e := v.Stat(p)
		if e != nil {
			return nil, "", e
		}
		if e = v.exportPath(p); e != nil {
			return nil, "", e
		}
		if !info.IsDir() {
			files[p] = false
			continue
		}
		directory = true
		files[p] = true
		entries, e := v.TreeAt(p)
		if e != nil {
			return nil, "", e
		}
		for _, entry := range entries {
			files[path.Join(p, entry.Path)] = entry.Dir
		}
	}
	// 仅收集已选笔记的附件，不追踪链接到的其他笔记。
	notes := make([]string, 0)
	for p, dir := range files {
		if !dir && IsNote(p) {
			notes = append(notes, p)
		}
	}
	for _, note := range notes {
		if e := ctx.Err(); e != nil {
			return nil, "", e
		}
		content, _, e := v.Read(note)
		if e != nil {
			return nil, "", e
		}
		var linkError error
		transformMarkdownLines(content, importRef, func(line []byte) []byte {
			if linkError != nil {
				return line
			}
			return transformOutsideCode(line, func(text []byte) []byte {
				for _, span := range importLinkSpans(text) {
					target := string(text[span.start:span.end])
					if span.html {
						target = html.UnescapeString(target)
					} else {
						target = markdownEscape.ReplaceAllString(target, "$1")
					}
					u, e := url.Parse(target)
					if e != nil {
						linkError = fmt.Errorf("%w：附件地址无效 %s", ErrInvalidPath, target)
						break
					}
					if u.IsAbs() || u.Host != "" || strings.HasPrefix(target, "/") || u.Path == "" {
						continue
					}
					rel := path.Clean(path.Join(path.Dir(note), u.Path))
					if IsNote(rel) {
						continue
					}
					if e = v.exportPath(rel); e != nil {
						linkError = fmt.Errorf("附件 %s：%w", rel, e)
						break
					}
					info, e := v.Stat(rel)
					if e != nil {
						linkError = fmt.Errorf("附件 %s：%w", rel, e)
						break
					}
					if !info.IsDir() {
						files[rel] = false
					}
				}
				return text
			})
		})
		if linkError != nil {
			return nil, "", linkError
		}
	}
	tmp, e := os.CreateTemp("", "rawmark-export-*")
	if e != nil {
		return nil, "", e
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	if len(paths) == 1 && !directory && len(files) == 1 && IsNote(paths[0]) {
		source, _, e := v.OpenRaw(paths[0])
		if e != nil {
			return nil, "", e
		}
		_, e = io.Copy(tmp, source)
		source.Close()
		if e != nil {
			return nil, "", e
		}
		name = path.Base(paths[0])
	} else {
		writer := zip.NewWriter(tmp)
		ordered := make([]string, 0, len(files))
		for p := range files {
			ordered = append(ordered, p)
		}
		sort.Strings(ordered)
		for _, p := range ordered {
			if e := ctx.Err(); e != nil {
				return nil, "", e
			}
			if e := v.exportPath(p); e != nil {
				return nil, "", e
			}
			if files[p] {
				if _, e := writer.Create(p + "/"); e != nil {
					return nil, "", e
				}
				continue
			}
			source, info, e := v.OpenRaw(p)
			if e != nil {
				return nil, "", e
			}
			header, e := zip.FileInfoHeader(info)
			if e != nil {
				source.Close()
				return nil, "", e
			}
			header.Name, header.Method = p, zip.Deflate
			dest, e := writer.CreateHeader(header)
			if e == nil {
				_, e = io.Copy(dest, source)
			}
			source.Close()
			if e != nil {
				return nil, "", e
			}
		}
		if e := writer.Close(); e != nil {
			return nil, "", e
		}
		name = "导出.zip"
		if len(paths) == 1 {
			name = strings.TrimSuffix(path.Base(paths[0]), NoteExt) + ".zip"
		}
	}
	if _, e := tmp.Seek(0, io.SeekStart); e != nil {
		return nil, "", e
	}
	return tmp, name, nil
}

// 附件可能通过 ../ 指向其他目录，但不能读取隐藏路径或经符号链接绕过范围。
func (v *Vault) exportPath(rel string) error {
	full, err := v.abs(rel)
	if err != nil {
		return err
	}
	real, err := filepath.EvalSymlinks(full)
	if os.IsNotExist(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if real != full {
		return ErrInvalidPath
	}
	return nil
}
