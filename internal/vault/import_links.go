package vault

import (
	"bytes"
	"context"
	"fmt"
	"html"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var importRef = regexp.MustCompile(`^ {0,3}\[[^\]\r\n]+\]:[ \t]*`)
var importSrc = regexp.MustCompile(`(?i)<(?:img|source|video|audio)\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']`)
var markdownEscape = regexp.MustCompile("\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])")

type importLink struct {
	start, end int
	html       bool
}

// linkDestination 返回目的地址本身的区间，不含尖括号、标题或闭合括号。
func linkDestination(text []byte, start int) (int, int) {
	for start < len(text) && (text[start] == ' ' || text[start] == '\t') {
		start++
	}
	if start == len(text) {
		return start, start
	}
	if text[start] == '<' {
		end := start + 1
		for end < len(text) && text[end] != '>' && text[end] != '\n' && text[end] != '\r' {
			if text[end] == '\\' && end+1 < len(text) {
				end++
			}
			end++
		}
		if end < len(text) && text[end] == '>' {
			return start + 1, end
		}
		return start, start
	}
	depth := 0
	end := start
	for end < len(text) {
		c := text[end]
		if c == '\\' && end+1 < len(text) {
			end += 2
			continue
		}
		if c == '(' {
			depth++
		}
		if c == ')' {
			if depth == 0 {
				break
			}
			depth--
		}
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			break
		}
		end++
	}
	if depth != 0 {
		return start, start
	}
	return start, end
}

func importLinkSpans(text []byte) []importLink {
	var spans []importLink
	if m := importRef.FindIndex(text); m != nil {
		start, end := linkDestination(text, m[1])
		if end > start {
			spans = append(spans, importLink{start, end, false})
		}
	}
	for pos := 0; pos < len(text); {
		i := bytes.Index(text[pos:], []byte("]("))
		if i < 0 {
			break
		}
		i += pos
		// 转义的闭括号不是链接语法。
		escapes := 0
		for j := i - 1; j >= 0 && text[j] == '\\'; j-- {
			escapes++
		}
		start, end := linkDestination(text, i+2)
		if escapes%2 == 0 && end > start {
			spans = append(spans, importLink{start, end, false})
		}
		pos = max(i+2, end)
	}
	for _, m := range importSrc.FindAllSubmatchIndex(text, -1) {
		spans = append(spans, importLink{m[2], m[3], true})
	}
	return spans
}

func (v *Vault) importLinks(ctx context.Context, note string, content []byte, total *int64) ([]byte, []string, error) {
	var failure error
	missing := map[string]bool{}
	replacements := map[string]string{}
	transform := func(text []byte) []byte {
		spans := importLinkSpans(text)
		// 区间可能来自 HTML 或 Markdown，按原始顺序替换，保持其他字节不变。
		sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
		var out []byte
		last := 0
		for _, span := range spans {
			if span.start < last || failure != nil {
				continue
			}
			raw := string(text[span.start:span.end])
			target := raw
			if span.html {
				target = html.UnescapeString(target)
			} else {
				target = markdownEscape.ReplaceAllString(target, "$1")
			}
			u, err := url.Parse(target)
			if err != nil || u.IsAbs() || u.Host != "" || strings.HasPrefix(target, "/") || u.Path == "" {
				continue
			}
			rel := path.Clean(path.Join(path.Dir(note), u.Path))
			if _, err := CleanPath(rel); err != nil {
				missing[rel] = true
				continue
			}
			info, err := os.Stat(filepath.Join(v.root, filepath.FromSlash(rel)))
			if os.IsNotExist(err) {
				missing[rel] = true
				continue
			}
			if err != nil {
				failure = err
				continue
			}
			if !info.Mode().IsRegular() {
				continue
			}
			switch strings.ToLower(path.Ext(rel)) {
			case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".apng", ".bmp", ".ico", ".tif", ".tiff":
			default:
				continue
			}
			replacement, found := replacements[rel]
			if !found {
				if err := ctx.Err(); err != nil {
					failure = err
					continue
				}
				data, err := os.ReadFile(filepath.Join(v.root, filepath.FromSlash(rel)))
				if err != nil {
					failure = err
					continue
				}
				// 只统计新生成的副本；已有同名附件必须与哈希对应的内容一致。
				dest := filepath.Join(v.root, filepath.FromSlash(AssetsDir(note)), assetName(data, path.Base(rel)))
				existing, readErr := os.ReadFile(dest)
				if readErr != nil && !os.IsNotExist(readErr) {
					failure = readErr
					continue
				}
				if readErr == nil && !bytes.Equal(data, existing) {
					failure = fmt.Errorf("%w：附件名称与内容冲突", ErrInvalidImport)
					continue
				}
				if os.IsNotExist(readErr) {
					if int64(len(data)) > maxImportExpanded-*total {
						failure = ErrTooLarge
						continue
					}
					*total += int64(len(data))
				}
				replacement, err = v.SaveAsset(note, path.Base(rel), bytes.NewReader(data), importAssetLimit)
				if err != nil {
					failure = err
					continue
				}
				replacements[rel] = replacement
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
			out = append(out, text[last:span.start]...)
			out = append(out, replacement...)
			last = span.end
		}
		return append(out, text[last:]...)
	}
	updated := transformMarkdownLines(content, importRef, func(line []byte) []byte { return transformOutsideCode(line, transform) })
	warnings := []string{}
	if len(missing) > 0 {
		warnings = append(warnings, note+"："+strconv.Itoa(len(missing))+" 个本地链接的目标不在导入内容中，已保留原链接")
	}
	return updated, warnings, failure
}
