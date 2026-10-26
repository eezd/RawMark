package vault

import (
	"bytes"
	"regexp"
	"strings"
)

// RewriteAssetLinks updates links from the old image directory (oldBase.assets/) after renaming a note.
// Handle inline links/images `](...)`, reference definitions `[x]: ...`, and HTML `src="..."`, skipping code and math.
func RewriteAssetLinks(content []byte, oldBase, newBase string) []byte {
	oldRaw := regexp.QuoteMeta(oldBase + AssetsExt + "/")
	oldEsc := regexp.QuoteMeta(EscapeLinkPath(oldBase+AssetsExt) + "/")
	target := `(\./)?(?:` + oldRaw + `|` + oldEsc + `)`
	inline := regexp.MustCompile(`(\]\(\s*<?|\bsrc\s*=\s*["'])` + target)
	refDef := regexp.MustCompile(`^( {0,3}\[[^\]]+\]:\s*<?)` + target)
	repl := []byte("${1}${2}" + strings.ReplaceAll(EscapeLinkPath(newBase+AssetsExt), "$", "$$") + "/")

	excluded := nonProseRanges(parseMetadata(content))
	replace := func(pattern *regexp.Regexp, source []byte, offset int) []byte {
		var out []byte
		last := 0
		for _, match := range pattern.FindAllSubmatchIndex(source, -1) {
			skip := false
			for _, region := range excluded {
				if offset+match[0] >= region[0] && offset+match[0] < region[1] {
					skip = true
					break
				}
			}
			if skip {
				continue
			}
			out = append(out, source[last:match[0]]...)
			out = pattern.Expand(out, repl, source, match)
			last = match[1]
		}
		return append(out, source[last:]...)
	}
	return transformMarkdownLines(content, refDef, func(line, _ []byte, offset int) []byte {
		line = transformOutsideCode(line, func(text []byte, start int) []byte { return replace(inline, text, offset+start) })
		return replace(refDef, line, offset)
	})
}

// transformMarkdownLines reuses container/code-block detection from link rewriting to preserve code examples during import.
func transformMarkdownLines(content []byte, refDef *regexp.Regexp, transform func(line, body []byte, offset int) []byte) []byte {
	lines := bytes.SplitAfter(content, []byte("\n"))
	var fence []byte // Current code fence string; nil when outside a fenced block.
	var containers []linkContainer
	paragraph := false
	lineOffset := 0
	for i, line := range lines {
		offset := lineOffset
		lineOffset += len(line)
		// Expand tabs for classification, but apply replacements to original bytes without reserializing Markdown.
		body := bytes.TrimRight(expandLinkTabs(line), "\r\n")
		width := len(body)
		matched := 0
		for _, container := range containers {
			indent := len(body) - len(bytes.TrimLeft(body, " "))
			if container.quote {
				if indent > 3 || indent == len(body) || body[indent] != '>' {
					break
				}
				body = body[indent+1:]
				if len(body) > 0 && body[0] == ' ' {
					body = body[1:]
				}
			} else if indent == len(body) {
				body = nil // Blank lines do not close list containers.
			} else if indent >= container.indent {
				body = body[container.indent:]
			} else {
				break
			}
			matched++
		}
		if matched < len(containers) {
			rest := bytes.TrimLeft(body, " ")
			if marker := listMarker.Find(rest); len(body)-len(rest) <= 3 && marker != nil {
				mark := bytes.TrimRight(marker, " ")
				// A new sibling list item ends the previous item's paragraph without the "only 1 interrupts a paragraph" restriction.
				if mark[len(mark)-1] == containers[matched].marker {
					paragraph = false
				}
			}
			containers = containers[:matched]
			fence = nil // Closing a container also closes its unclosed code block.
			// Paragraphs allow lazy continuation without quote/list prefixes; do not mistake their indentation for code.
		}
		if fence != nil {
			trimmed := bytes.TrimLeft(body, " ")
			if len(body)-len(trimmed) <= 3 && bytes.HasPrefix(trimmed, fence) && len(bytes.TrimSpace(bytes.TrimLeft(trimmed, string(fence[:1])))) == 0 {
				fence = nil
			}
			continue
		}
		// New quotes or lists may nest; strip continuation indentation using the list's content-start column.
		for {
			indent := len(body) - len(bytes.TrimLeft(body, " "))
			if indent > 3 || indent == len(body) {
				break
			}
			rest := body[indent:]
			if rest[0] == '>' {
				containers = append(containers, linkContainer{quote: true})
				body = rest[1:]
				if len(body) > 0 && body[0] == ' ' {
					body = body[1:]
				}
			} else if paragraphBoundary.Match(rest) {
				break // Thematic breaks take precedence over list markers.
			} else if marker := listMarker.Find(rest); marker != nil {
				mark := bytes.TrimRight(marker, " ")
				// Only nonempty ordered lists starting at 1 may interrupt a paragraph.
				if paragraph && (len(marker) == len(rest) || (mark[0] >= '0' && mark[0] <= '9' && !bytes.Equal(mark[:len(mark)-1], []byte("1")))) {
					break
				}
				padding := len(marker) - len(mark)
				if padding == 0 || padding > 4 {
					padding = 1
				}
				width := indent + len(mark) + padding
				containers = append(containers, linkContainer{indent: width, marker: mark[len(mark)-1]})
				body = body[min(width, len(body)):]
			} else {
				break
			}
			paragraph = false
		}
		trimmed := bytes.TrimLeft(body, " ")
		if len(trimmed) == 0 {
			paragraph = false
			continue
		}
		// Indented code cannot interrupt an existing paragraph; the list container's indentation does not count toward the four columns.
		if len(body)-len(trimmed) >= 4 && !paragraph {
			continue
		}
		if f := fenceOpen(body); f != nil {
			fence = f
			paragraph = false
			continue
		}
		paragraph = !paragraphBoundary.Match(trimmed) && !refDef.Match(trimmed)
		// Map expanded container columns back to original bytes, preserving tabs and text positions.
		start, column := 0, 0
		for column < width-len(body) {
			if line[start] == '\t' {
				column += 4 - column%4
			} else {
				column++
			}
			start++
		}
		lines[i] = transform(line, line[start:], offset)
	}
	return bytes.Join(lines, nil)
}

type linkContainer struct {
	quote  bool
	indent int
	marker byte
}

var listMarker = regexp.MustCompile(`^(?:[-+*]|[0-9]{1,9}[.)])(?: +|$)`)
var paragraphBoundary = regexp.MustCompile(`^(?:#{1,6}(?: |$)|(?:\* *){3,}$|(?:_ *){3,}$|(?:- *){3,}$|[=-]+ *$)`)

func expandLinkTabs(line []byte) []byte {
	if !bytes.ContainsRune(line, '\t') {
		return line
	}
	var out []byte
	for _, ch := range line {
		if ch == '\t' {
			out = append(out, bytes.Repeat([]byte(" "), 4-len(out)%4)...)
		} else {
			out = append(out, ch)
		}
	}
	return out
}

// fenceOpen recognizes a fenced-code opening (up to three leading spaces, at least three backticks or tildes) and returns its fence string.
func fenceOpen(line []byte) []byte {
	indent := len(line) - len(bytes.TrimLeft(line, " "))
	if indent > 3 {
		return nil
	}
	rest := line[indent:]
	if len(rest) < 3 || (rest[0] != '`' && rest[0] != '~') {
		return nil
	}
	n := 0
	for n < len(rest) && rest[n] == rest[0] {
		n++
	}
	if n < 3 || (rest[0] == '`' && bytes.IndexByte(rest[n:], '`') >= 0) {
		return nil
	}
	return rest[:n]
}

// transformOutsideCode transforms only fragments outside inline code `...`.
func transformOutsideCode(line []byte, transform func(text []byte, offset int) []byte) []byte {
	var out []byte
	offset := 0
	for len(line) > 0 {
		start := bytes.IndexByte(line, '`')
		if start < 0 {
			break
		}
		n := 1
		for start+n < len(line) && line[start+n] == '`' {
			n++
		}
		end := bytes.Index(line[start+n:], line[start:start+n])
		if end < 0 {
			break
		}
		codeEnd := start + n + end + n
		out = append(out, transform(line[:start], offset)...)
		out = append(out, line[start:codeEnd]...)
		line = line[codeEnd:]
		offset += codeEnd
	}
	return append(out, transform(line, offset)...)
}
