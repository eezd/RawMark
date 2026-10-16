package vault

import (
	"bytes"
	"regexp"
	"strings"
)

// RewriteAssetLinks 在笔记改名后，把正文中指向旧图片目录（oldBase.assets/）的链接改为新目录。
// 覆盖行内链接/图片 `](…)`、引用定义 `[x]: …` 与 HTML `src="…"`，跳过围栏代码块和行内代码。
func RewriteAssetLinks(content []byte, oldBase, newBase string) []byte {
	oldRaw := regexp.QuoteMeta(oldBase + AssetsExt + "/")
	oldEsc := regexp.QuoteMeta(EscapeLinkPath(oldBase+AssetsExt) + "/")
	target := `(\./)?(?:` + oldRaw + `|` + oldEsc + `)`
	inline := regexp.MustCompile(`(\]\(\s*<?|\bsrc\s*=\s*["'])` + target)
	refDef := regexp.MustCompile(`^( {0,3}\[[^\]]+\]:\s*<?)` + target)
	repl := []byte("${1}${2}" + strings.ReplaceAll(EscapeLinkPath(newBase+AssetsExt), "$", "$$") + "/")

	lines := bytes.SplitAfter(content, []byte("\n"))
	var fence []byte // 当前所在围栏代码块的围栏字符串，nil 表示不在代码块中
	for i, line := range lines {
		trimmed := bytes.TrimLeft(line, " ")
		if fence != nil {
			if bytes.HasPrefix(trimmed, fence) && len(bytes.TrimSpace(bytes.TrimLeft(trimmed, string(fence[:1])))) == 0 {
				fence = nil
			}
			continue
		}
		if f := fenceOpen(line); f != nil {
			fence = f
			continue
		}
		line = refDef.ReplaceAll(line, repl)
		lines[i] = replaceOutsideCode(line, inline, repl)
	}
	return bytes.Join(lines, nil)
}

// fenceOpen 识别围栏代码块起始行（至多 3 个空格缩进，3 个以上 ` 或 ~），返回围栏字符串
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

// replaceOutsideCode 只在行内代码 `…` 之外的片段上做替换
func replaceOutsideCode(line []byte, re *regexp.Regexp, repl []byte) []byte {
	var out []byte
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
		out = append(out, re.ReplaceAll(line[:start], repl)...)
		out = append(out, line[start:codeEnd]...)
		line = line[codeEnd:]
	}
	return append(out, re.ReplaceAll(line, repl)...)
}
