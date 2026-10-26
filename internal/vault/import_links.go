package vault

import (
	"bytes"
	"context"
	"html"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"rawmark/internal/i18n"
	"regexp"
	"sort"
	"strings"
)

var importRef = regexp.MustCompile(`(?m)^ {0,3}\[[^\[\]\r\n]+\]:[ \t]*`)
var importSrc = regexp.MustCompile(`(?i)<(?:img|source|video|audio)\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']`)
var markdownEscape = regexp.MustCompile("\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])")

type importLink struct {
	start, end int
	html       bool
}

// 链接中的空白允许一次换行，但不能跨过段落。
func linkSpace(text []byte, pos int) int {
	newline := false
	for pos < len(text) {
		switch text[pos] {
		case ' ', '\t', '\r':
		case '\n':
			if newline {
				return pos
			}
			newline = true
		default:
			return pos
		}
		pos++
	}
	return pos
}

// linkDestination 返回地址区间和地址结束后的下标；地址本身不含尖括号。
func linkDestination(text []byte, pos int) (start, end, next int) {
	start = linkSpace(text, pos)
	if start == len(text) {
		return start, start, start
	}
	if text[start] == '<' {
		for end = start + 1; end < len(text); end++ {
			switch text[end] {
			case '\\':
				if end+1 < len(text) {
					end++
				}
			case '>':
				return start + 1, end, end + 1
			case '<', '\n', '\r', 0:
				return start, start, start
			}
		}
		return start, start, start
	}
	depth := 0
	for end = start; end < len(text); end++ {
		c := text[end]
		if c == '\\' && end+1 < len(text) {
			end++
			continue
		}
		if c == '(' {
			depth++
		} else if c == ')' {
			if depth == 0 {
				break
			}
			depth--
		} else if c <= ' ' || c == '<' || c == 0x7f {
			break
		}
	}
	if depth != 0 {
		return start, start, start
	}
	return start, end, end
}

func linkTitleEnd(text []byte, pos int) int {
	quote := text[pos]
	close := quote
	if quote == '(' {
		close = ')'
	}
	for i := pos + 1; i < len(text); i++ {
		if text[i] == '\\' && i+1 < len(text) {
			i++
		} else if text[i] == close {
			return i + 1
		} else if (quote == '(' && text[i] == '(') || (text[i] == '\n' && linkSpace(text, i) < len(text) && text[linkSpace(text, i)] == '\n') {
			break
		}
	}
	return -1
}

// importLinkSpans 共用于导入、导出和图片改名；返回原文字节位置，不重新序列化正文。
func importLinkSpans(content []byte) []importLink {
	var text []byte
	var source []int
	lastEnd := 0
	transformMarkdownLines(content, importRef, func(line, body []byte, offset int) []byte {
		if len(text) > 0 && offset != lastEnd {
			text = append(text, '\n', '\n')
			source = append(source, -1, -1)
		}
		start := offset + len(line) - len(body)
		text = append(text, body...)
		for i := range body {
			source = append(source, start+i)
		}
		lastEnd = offset + len(line)
		return line
	})
	// 行内代码可以跨行。遮住其中的标记，同时保留链接标签两侧的括号结构。
	masked := bytes.Repeat([]byte(" "), len(text))
	pos := 0
	for _, paragraph := range bytes.SplitAfter(text, []byte("\n\n")) {
		transformOutsideCode(paragraph, func(part []byte, offset int) []byte {
			copy(masked[pos+offset:], part)
			return part
		})
		pos += len(paragraph)
	}
	text = masked
	var spans []importLink
	add := func(start, end int, html bool) {
		spans = append(spans, importLink{source[start], source[end-1] + 1, html})
	}
	definitionEnd := 0
	for _, m := range importRef.FindAllIndex(text, -1) {
		if m[0] < definitionEnd {
			continue
		}
		label := bytes.TrimSpace(text[m[0]:m[1]])
		if bytes.HasPrefix(label, []byte("[^")) || len(bytes.TrimSpace(label[1:bytes.IndexByte(label, ']')])) == 0 {
			continue
		}
		start, end, next := linkDestination(text, m[1])
		if end == start {
			continue
		}
		titleStart := linkSpace(text, next)
		if titleStart > next && titleStart < len(text) && (text[titleStart] == '"' || text[titleStart] == '\'' || text[titleStart] == '(') {
			titleEnd := linkTitleEnd(text, titleStart)
			if titleEnd >= 0 {
				for titleEnd < len(text) && (text[titleEnd] == ' ' || text[titleEnd] == '\t' || text[titleEnd] == '\r') {
					titleEnd++
				}
				if titleEnd == len(text) || text[titleEnd] == '\n' {
					next = titleEnd
				}
			}
		}
		for next < len(text) && (text[next] == ' ' || text[next] == '\t' || text[next] == '\r') {
			next++
		}
		if next < len(text) && text[next] != '\n' {
			continue
		}
		add(start, end, false)
		definitionEnd = next
		// 引用定义及其标题不是行内正文，避免再次扫描标题中的示例标记。
		for i := m[0]; i < next; i++ {
			if text[i] != '\n' && text[i] != '\r' {
				text[i] = ' '
			}
		}
	}
	var brackets []int
	for i := 0; i < len(text); i++ {
		switch text[i] {
		case '\\':
			i++
		case '\n':
			if next := linkSpace(text, i); next < len(text) && text[next] == '\n' {
				brackets = nil
			}
		case '[':
			brackets = append(brackets, i)
		case ']':
			if len(brackets) == 0 {
				continue
			}
			open := brackets[len(brackets)-1]
			brackets = brackets[:len(brackets)-1]
			if i+1 == len(text) || text[i+1] != '(' {
				continue
			}
			start, end, next := linkDestination(text, i+2)
			if end == start {
				continue
			}
			close := linkSpace(text, next)
			if close > next && close < len(text) && (text[close] == '"' || text[close] == '\'' || text[close] == '(') {
				close = linkTitleEnd(text, close)
				if close < 0 {
					continue
				}
				close = linkSpace(text, close)
			}
			if close < len(text) && text[close] == ')' {
				add(start, end, false)
				i = close
				if open == 0 || text[open-1] != '!' {
					brackets = nil // 链接不能嵌套，图片可以位于链接标签内。
				}
			}
		}
	}
	for _, m := range importSrc.FindAllSubmatchIndex(text, -1) {
		if m[3] > m[2] {
			add(m[2], m[3], true)
		}
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	return spans
}

func (v *Vault) importLinks(ctx context.Context, note string, content []byte, total *int64, migrated map[string]bool) ([]byte, []*i18n.Error, error) {
	missing := map[string]bool{}
	replacements := map[string]string{}
	spans := importLinkSpans(content)
	var out []byte
	last := 0
	for _, span := range spans {
		if span.start < last {
			continue
		}
		raw := string(content[span.start:span.end])
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
			return nil, nil, err
		}
		if !info.Mode().IsRegular() {
			continue
		}
		if !IsImage(rel) {
			continue
		}
		replacement, found := replacements[rel]
		if !found {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
			data, err := os.ReadFile(filepath.Join(v.root, filepath.FromSlash(rel)))
			if err != nil {
				return nil, nil, err
			}
			// 只统计新生成的副本；已有同名附件必须与哈希对应的内容一致。
			dir := path.Join(path.Dir(note), "assets")
			dest, exists, err := v.assetDestination(dir, assetName(data, path.Base(rel)), data)
			if err != nil {
				return nil, nil, err
			}
			if !exists {
				if int64(len(data)) > maxImportExpanded-*total {
					return nil, nil, ErrTooLarge
				}
				*total += int64(len(data))
			}
			replacement, err = v.SaveAsset(note, path.Base(rel), bytes.NewReader(data), importAssetLimit)
			if err != nil {
				return nil, nil, err
			}
			if dest != rel {
				migrated[rel] = true
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
		out = append(out, content[last:span.start]...)
		out = append(out, replacement...)
		last = span.end
	}
	updated := append(out, content[last:]...)
	warnings := []*i18n.Error{}
	if len(missing) > 0 {
		warnings = append(warnings, i18n.New("import_missing_links", note, len(missing)))
	}
	return updated, warnings, nil
}
