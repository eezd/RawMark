import type { SyntaxNode } from '@lezer/common'
import type { MarkdownParser } from '@lezer/markdown'
import { parser as commonmarkParser, Emoji, GFM, Subscript, Superscript } from '@lezer/markdown'
import { typoraExtensions } from './extensions'
import { inlineStyleText, stylesFromTag } from './inline-styles'

// 与编辑器一致的语法集（lang-markdown 的 markdownLanguage 加 Typora 扩展）
export const markdownParser = commonmarkParser.configure([GFM, Subscript, Superscript, Emoji, ...typoraExtensions])

export { commonmarkParser }

interface Line {
  rest: string
  col: number
}

interface LinkDefinition {
  href: string
  title: string | null
}

const BLOCK_CONTAINERS = new Set(['Blockquote', 'ListItem'])

const footnoteId = (label: string) => `fn-${label.toLowerCase().replace(/\s+/g, '-')}`

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))
}

// 属性值中保留实体引用（交给浏览器解码），只转义其余的特殊字符
function escapeAttr(s: string): string {
  return s.replace(/&(?!(?:#\d{1,7}|#x[\da-f]{1,6}|[A-Z][A-Z\d]{1,31});)|[<>"]/gi, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;')
}

function unescapeBackslashes(s: string): string {
  return s.replace(/\\([\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/g, '$1')
}

// 对非法 URL 字符做百分号编码，已有的 %XX 保留
function normalizeUrl(s: string): string {
  return s.replace(/%(?![\da-f]{2})|[^\w\-.~:/?#[\]@!$&'()*+,;=%]/gi, c => encodeURIComponent(c))
}

function normalizeLabel(s: string): string {
  return s.slice(1, -1).trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase()
}

function tabWidth(col: number): number {
  return 4 - (col % 4)
}

export interface RenderOptions {
  parser?: MarkdownParser
  // 为 true 时原样输出原始 HTML、不过滤危险链接协议；仅用于可信内容（如规范测试）
  unsafe?: boolean
}

const UNSAFE_PROTOCOL = /^\s*(javascript|vbscript|file|data):/i
const SAFE_DATA_IMAGE = /^\s*data:image\/(png|gif|jpeg|webp);/i

function safeHref(href: string): string {
  // 协议由 ASCII 组成；属性实体会被浏览器解码，URL 解析还会忽略制表符和换行。
  const protocol = href.replace(/&#(?:(\d{1,7})|[xX]([\da-fA-F]{1,6}));|&(colon|Tab|NewLine);/g, (entity, decimal, hex, named) => {
    if (named) return named === 'colon' ? ':' : named === 'Tab' ? '\t' : '\n'
    const code = decimal ? Number(decimal) : Number.parseInt(hex, 16)
    return code <= 127 ? String.fromCharCode(code) : entity
  // eslint-disable-next-line no-control-regex -- URL 安全检查必须移除 ASCII 控制字符。
  }).replace(/[\t\r\n]/g, '').replace(/^[\x00-\x20]+/, '')
  return UNSAFE_PROTOCOL.test(protocol) && !SAFE_DATA_IMAGE.test(protocol) ? '#' : href
}

export function renderMarkdown(src: string, { parser = markdownParser, unsafe = false }: RenderOptions = {}): string {
  const tree = parser.parse(src)
  const linkHref = (href: string) => unsafe ? href : safeHref(href)
  const rawHtml = (s: string) => (unsafe ? s : escapeHtml(s))
  const text = (from: number, to: number) => src.slice(from, to)
  const defs = new Map<string, LinkDefinition>()

  tree.iterate({
    enter(ref) {
      if (ref.name !== 'LinkReference') return
      const node = ref.node
      const label = node.getChild('LinkLabel')
      const url = node.getChild('URL')
      if (!label || !url) return false
      const key = normalizeLabel(text(label.from, label.to))
      if (!defs.has(key)) defs.set(key, { href: destination(url), title: linkTitle(node.getChild('LinkTitle')) })
      return false
    },
  })

  function destination(url: SyntaxNode): string {
    let s = text(url.from, url.to)
    if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1)
    return normalizeUrl(unescapeBackslashes(s))
  }

  function linkTitle(node: SyntaxNode | null): string | null {
    return node ? unescapeBackslashes(text(node.from + 1, node.to - 1)) : null
  }

  // ---- 容器前缀剥离：代码块、HTML 块需要按 CommonMark 的列规则去掉引用符与列表缩进 ----

  function containers(node: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = []
    for (let p = node.parent; p; p = p.parent) {
      if (BLOCK_CONTAINERS.has(p.name)) out.unshift(p)
    }
    return out
  }

  function lineStart(pos: number): number {
    return src.lastIndexOf('\n', pos - 1) + 1
  }

  function lineEnd(pos: number): number {
    const i = src.indexOf('\n', pos)
    return i < 0 ? src.length : i
  }

  function columnAt(pos: number): number {
    let col = 0
    for (let i = lineStart(pos); i < pos; i++) col += src[i] === '\t' ? tabWidth(col) : 1
    return col
  }

  // 列表项内容的起始列（绝对列号）
  function itemContentColumn(item: SyntaxNode): number {
    const mark = item.getChild('ListMark')!
    const markEnd = columnAt(mark.to)
    let col = markEnd
    let i = mark.to
    const end = lineEnd(mark.to)
    while (i < end && (src[i] === ' ' || src[i] === '\t')) col += src[i++] === '\t' ? tabWidth(col) : 1
    if (i === end || col - markEnd > 4) return markEnd + 1
    return col
  }

  // 去掉一行开头属于容器的部分，返回剩余文本（被拆开的制表符以空格补齐）
  function stripContainers(lineFrom: number, cs: SyntaxNode[]): { rest: string, col: number } {
    const end = lineEnd(lineFrom)
    let i = lineFrom
    let col = 0
    let pad = 0
    const eatColumns = (target: number) => {
      while (col + pad < target && i < end && (src[i] === ' ' || src[i] === '\t')) {
        const w = src[i] === '\t' ? tabWidth(col) : 1
        if (col + w > target) {
          pad = col + w - target
          col = target
          i++
          return
        }
        col += w
        i++
      }
    }
    for (const c of cs) {
      if (c.name === 'Blockquote') {
        const base = col
        eatColumns(base + 3)
        if (src[i] === '>') {
          i++
          col++
          pad = 0
          if (src[i] === ' ') {
            i++
            col++
          } else if (src[i] === '\t') {
            const w = tabWidth(col)
            i++
            col++
            pad = w - 1
          }
        }
      } else {
        const target = itemContentColumn(c)
        if (lineStart(c.from) === lineFrom) {
          // 列表项首行：跳过列表标记本身
          const mark = c.getChild('ListMark')!
          col = columnAt(mark.to)
          i = mark.to
          pad = 0
        }
        if (pad) {
          const use = Math.min(pad, target - col)
          pad -= use
          col += use
        }
        eatColumns(target)
      }
    }
    // pad 个空格（被拆开的制表符剩余部分）从第 col 列开始
    return { rest: ' '.repeat(pad) + src.slice(i, end), col }
  }

  // 去掉至多 n 列的前导空白；startCol 为该行文本起始的绝对列，用于计算制表符宽度
  function stripIndent({ rest: line, col: startCol }: Line, n: number): string {
    let col = 0
    let i = 0
    while (col < n && i < line.length && (line[i] === ' ' || line[i] === '\t')) {
      const w = line[i] === '\t' ? tabWidth(startCol + col) : 1
      if (col + w > n) return ' '.repeat(col + w - n) + line.slice(i + 1)
      col += w
      i++
    }
    return line.slice(i)
  }

  function contentLines(node: SyntaxNode, skipFirst: boolean, skipLast: boolean): Line[] {
    const cs = containers(node)
    const lines: Line[] = []
    let pos = lineStart(node.from)
    // 未闭合的块会延伸到文末换行之后，那一行不属于内容
    const last = lineStart(node.to > node.from && src[node.to - 1] === '\n' ? node.to - 1 : node.to)
    for (let first = true; pos <= last; first = false) {
      const isLast = pos === last
      if (!(first && skipFirst) && !(isLast && skipLast)) lines.push(stripContainers(pos, cs))
      if (pos >= src.length) break
      pos = lineEnd(pos) + 1
    }
    return lines
  }

  // ---- 行内 ----

  function inline(parent: SyntaxNode, from: number, to: number): string {
    let out = ''
    let pos = from
    // 引用符和硬换行之后的行首空白不属于内容
    let afterQuote = false
    for (let ch = parent.firstChild; ch; ch = ch.nextSibling) {
      if (ch.to <= from || ch.from >= to) continue
      if (ch.from > pos) out += textSegment(text(pos, ch.from), afterQuote)
      afterQuote = ch.name === 'QuoteMark' || ch.name === 'HardBreak'
      out += inlineNode(ch)
      pos = ch.to
    }
    if (pos < to) out += textSegment(text(pos, to), afterQuote)
    return out
  }

  function textSegment(s: string, afterQuote: boolean): string {
    s = s.replace(/[ \t]*\n[ \t]*/g, '\n')
    if (afterQuote) s = s.replace(/^[ \t]+/, '')
    return escapeHtml(s)
  }

  function innerOf(node: SyntaxNode, markName: string): string {
    const marks = node.getChildren(markName)
    if (marks.length < 2) return inline(node, node.from, node.to)
    return inline(node, marks[0].to, marks[marks.length - 1].from)
  }

  function plainText(html: string): string {
    return html.replace(/<img [^>]*?alt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]*>/g, '')
  }

  function inlineNode(node: SyntaxNode): string {
    switch (node.name) {
      case 'QuoteMark':
      case 'HeaderMark':
        return ''
      case 'Escape':
        return escapeHtml(text(node.from + 1, node.to))
      case 'Entity': {
        const ent = text(node.from, node.to)
        return /^&#(\d{8,}|x[\da-f]{7,});$/i.test(ent) ? escapeHtml(ent) : ent
      }
      case 'HardBreak':
        return '<br />\n'
      case 'Emphasis':
        return `<em>${innerOf(node, 'EmphasisMark')}</em>`
      case 'StrongEmphasis':
        return `<strong>${innerOf(node, 'EmphasisMark')}</strong>`
      case 'Strikethrough':
        return `<del>${innerOf(node, 'StrikethroughMark')}</del>`
      case 'Superscript':
        return `<sup>${innerOf(node, 'SuperscriptMark')}</sup>`
      case 'Subscript':
        return `<sub>${innerOf(node, 'SubscriptMark')}</sub>`
      case 'Highlight':
        return `<mark>${innerOf(node, 'HighlightMark')}</mark>`
      case 'Underline':
        return `<u>${innerOf(node, 'UnderlineMark')}</u>`
      case 'InlineStyle': {
        const open = node.getChild('InlineStyleMark')!
        const styles = stylesFromTag(text(open.from, open.to))!
        return `<span style="${escapeAttr(inlineStyleText(styles))}">${innerOf(node, 'InlineStyleMark')}</span>`
      }
      // 公式与 emoji 输出占位元素，由 render.ts 的 hydrate 按需加载依赖后填充
      case 'InlineMath': {
        const tex = text(node.from + 1, node.to - 1)
        return `<span data-math="${escapeHtml(tex)}">${escapeHtml(tex)}</span>`
      }
      case 'Emoji': {
        const raw = text(node.from, node.to)
        return `<span data-emoji="${escapeHtml(raw.slice(1, -1))}">${escapeHtml(raw)}</span>`
      }
      case 'FootnoteReference': {
        const label = text(node.from + 2, node.to - 1)
        return `<sup class="footnote-ref"><a href="#${escapeAttr(footnoteId(label))}">${escapeHtml(label)}</a></sup>`
      }
      case 'InlineCode': {
        const marks = node.getChildren('CodeMark')
        let code = text(marks[0].to, marks[marks.length - 1].from).replace(/\n/g, ' ')
        if (/^ +[^ ].* $/s.test(code)) code = code.slice(1, -1)
        return `<code>${escapeHtml(code)}</code>`
      }
      case 'HTMLTag':
      case 'Comment':
      case 'ProcessingInstruction':
        return rawHtml(text(node.from, node.to))
      case 'Autolink': {
        const url = node.getChild('URL')
        if (!url) return escapeHtml(text(node.from, node.to))
        const raw = text(url.from, url.to)
        const href = /^[^@\s]+@[^@\s]+$/.test(raw) && !raw.includes(':') ? `mailto:${raw}` : raw
        return `<a href="${escapeAttr(linkHref(normalizeUrl(href)))}">${escapeHtml(raw)}</a>`
      }
      case 'URL': {
        // GFM 裸链接
        const raw = text(node.from, node.to)
        const href = raw.startsWith('www.') ? `http://${raw}` : raw.includes('@') && !raw.includes(':') ? `mailto:${raw}` : raw
        return `<a href="${escapeAttr(linkHref(normalizeUrl(href)))}">${escapeHtml(raw)}</a>`
      }
      case 'Link':
      case 'Image':
        return linkOrImage(node)
      default:
        return escapeHtml(text(node.from, node.to))
    }
  }

  function linkOrImage(node: SyntaxNode): string {
    const isImage = node.name === 'Image'
    const marks = node.getChildren('LinkMark')
    const labelFrom = node.from + (isImage ? 2 : 1)
    const closeBracket = marks.find(m => m.from >= labelFrom && text(m.from, m.to) === ']')
    if (!closeBracket) return escapeHtml(text(node.from, node.to))
    const content = inline(node, labelFrom, closeBracket.from)
    let def: LinkDefinition | undefined
    const url = node.getChild('URL')
    if (marks.some(m => text(m.from, m.to) === '(')) {
      def = { href: url ? destination(url) : '', title: linkTitle(node.getChild('LinkTitle')) }
    } else {
      const label = node.getChild('LinkLabel')
      const key = label && text(label.from, label.to) !== '[]' ? text(label.from, label.to) : text(labelFrom - 1, closeBracket.to)
      def = defs.get(normalizeLabel(key))
      if (!def) {
        // 引用未定义：按字面文本输出
        const tail = label ? escapeHtml(unescapeBackslashes(text(label.from, label.to))) : ''
        return `${isImage ? '!' : ''}[${content}]${tail}`
      }
    }
    const title = def.title !== null ? ` title="${escapeAttr(def.title)}"` : ''
    if (isImage) return `<img src="${escapeAttr(linkHref(def.href))}" alt="${escapeAttr(plainText(content))}"${title} />`
    return `<a href="${escapeAttr(linkHref(def.href))}"${title}>${content}</a>`
  }

  // ---- 块级 ----

  function isBlank(line: string): boolean {
    return /^[ \t>]*$/.test(line)
  }

  function hasBlankLineBetween(a: SyntaxNode, b: SyntaxNode): boolean {
    const lines = text(a.to, b.from).split('\n')
    return lines.slice(1, -1).some(isBlank)
  }

  function blockChildren(node: SyntaxNode, withDefinitions = false): SyntaxNode[] {
    const out: SyntaxNode[] = []
    for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
      if (ch.name.endsWith('Mark')) continue
      if (ch.name !== 'LinkReference' || withDefinitions) out.push(ch)
    }
    return out
  }

  function isLoose(list: SyntaxNode): boolean {
    const items = list.getChildren('ListItem')
    for (let i = 0; i + 1 < items.length; i++) {
      if (hasBlankLineBetween(items[i], items[i + 1])) return true
    }
    for (const item of items) {
      const kids = blockChildren(item, true)
      for (let i = 0; i + 1 < kids.length; i++) {
        if (hasBlankLineBetween(kids[i], kids[i + 1])) return true
      }
    }
    return false
  }

  function blocks(node: SyntaxNode, tight = false): string {
    let out = ''
    for (let ch = node.firstChild; ch; ch = ch.nextSibling) out += block(ch, tight)
    return out
  }

  function block(node: SyntaxNode, tight: boolean): string {
    const name = node.name
    if (name.startsWith('ATXHeading')) {
      const level = name.slice(-1)
      const marks = node.getChildren('HeaderMark')
      const from = marks.length ? marks[0].to : node.from
      const to = marks.length > 1 ? marks[marks.length - 1].from : node.to
      return `<h${level}>${inline(node, from, to).trim()}</h${level}>\n`
    }
    if (name.startsWith('SetextHeading')) {
      const level = name.slice(-1)
      const mark = node.getChildren('HeaderMark').pop()!
      return `<h${level}>${inline(node, node.from, mark.from).trim()}</h${level}>\n`
    }
    switch (name) {
      case 'Paragraph': {
        const body = inline(node, node.from, node.to).trim()
        return tight ? `${body}\n` : `<p>${body}</p>\n`
      }
      case 'Task': {
        const marker = node.getChild('TaskMarker')!
        const checked = text(marker.from + 1, marker.from + 2) !== ' ' ? ' checked=""' : ''
        const body = `<input type="checkbox" disabled=""${checked} /> ${inline(node, marker.to, node.to).trim()}`
        return tight ? `${body}\n` : `<p>${body}</p>\n`
      }
      case 'Blockquote':
        return `<blockquote>\n${blocks(node)}</blockquote>\n`
      case 'BulletList':
      case 'OrderedList': {
        const loose = isLoose(node)
        const tag = name === 'BulletList' ? 'ul' : 'ol'
        let attrs = ''
        if (tag === 'ol') {
          const first = node.getChild('ListItem')!.getChild('ListMark')!
          const start = parseInt(text(first.from, first.to), 10)
          if (start !== 1) attrs = ` start="${start}"`
        }
        let items = ''
        for (const item of node.getChildren('ListItem')) items += listItem(item, !loose)
        return `<${tag}${attrs}>\n${items}</${tag}>\n`
      }
      case 'HorizontalRule':
        return '<hr />\n'
      case 'FencedCode': {
        const marks = node.getChildren('CodeMark')
        const closed = marks.length > 1
        const info = node.getChild('CodeInfo')
        const lang = info ? unescapeBackslashes(text(info.from, info.to).trim().split(/\s/)[0]) : ''
        const cs = containers(node)
        const fenceIndent = columnAt(marks[0].from) - stripContainers(lineStart(marks[0].from), cs).col
        const lines = contentLines(node, true, closed).map(l => stripIndent(l, fenceIndent))
        const cls = lang ? ` class="language-${escapeAttr(lang)}"` : ''
        const code = lines.length ? `${lines.join('\n')}\n` : ''
        return `<pre><code${cls}>${escapeHtml(code)}</code></pre>\n`
      }
      case 'CodeBlock': {
        const lines = contentLines(node, false, false).map(l => stripIndent(l, 4))
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
        return `<pre><code>${escapeHtml(`${lines.join('\n')}\n`)}</code></pre>\n`
      }
      case 'HTMLBlock':
      case 'CommentBlock':
      case 'ProcessingInstructionBlock':
        return `${rawHtml(contentLines(node, false, false).map(l => l.rest).join('\n'))}\n`
      case 'Table':
        return table(node)
      case 'BlockMath': {
        const marks = node.getChildren('BlockMathMark')
        const from = Math.min(lineEnd(node.from) + 1, node.to)
        const to = marks.length > 1 ? Math.max(from, lineStart(marks[marks.length - 1].from) - 1) : node.to
        const tex = text(from, to)
        return `<div data-math="${escapeHtml(tex)}">${escapeHtml(tex)}</div>\n`
      }
      case 'FootnoteDefinition': {
        const label = node.getChild('FootnoteLabel')!
        const name = text(label.from + 2, label.to - 2)
        return `<div class="footnote" id="${escapeAttr(footnoteId(name))}"><sup>${escapeHtml(name)}</sup> ${inline(node, label.to, node.to).trim()}</div>\n`
      }
      // 目录占位，由调用方根据标题填充
      case 'TableOfContents':
        return '<nav class="toc"></nav>\n'
      // front matter 是元数据，不输出
      default:
        return ''
    }
  }

  function listItem(item: SyntaxNode, tight: boolean): string {
    const kids = blockChildren(item)
    if (!kids.length) return '<li></li>\n'
    let body = ''
    for (const k of kids) body += block(k, tight)
    const startsInline = tight && (kids[0].name === 'Paragraph' || kids[0].name === 'Task')
    const last = kids[kids.length - 1].name
    const endsInline = tight && (last === 'Paragraph' || last === 'Task')
    if (!startsInline) body = `\n${body}`
    if (endsInline) body = body.replace(/\n$/, '')
    return `<li>${body}</li>\n`
  }

  function table(node: SyntaxNode): string {
    const delimiter = node.getChild('TableDelimiter')
    const aligns = delimiter
      ? text(delimiter.from, delimiter.to)
          .replace(/^\s*\|?|\|?\s*$/g, '')
          .split('|')
          .map((c) => {
            const s = c.trim()
            return s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : s.startsWith(':') ? 'left' : ''
          })
      : []
    const row = (r: SyntaxNode, tag: string) => {
      const cells = r.getChildren('TableCell')
      let out = '<tr>\n'
      for (let i = 0; i < aligns.length; i++) {
        const align = aligns[i] ? ` align="${aligns[i]}"` : ''
        const cell = cells[i]
        out += `<${tag}${align}>${cell ? inline(cell, cell.from, cell.to).trim() : ''}</${tag}>\n`
      }
      return `${out}</tr>\n`
    }
    const header = node.getChild('TableHeader')
    let out = '<table>\n'
    if (header) out += `<thead>\n${row(header, 'th')}</thead>\n`
    const rows = node.getChildren('TableRow')
    if (rows.length) out += `<tbody>\n${rows.map(r => row(r, 'td')).join('')}</tbody>\n`
    return `${out}</table>\n`
  }

  return blocks(tree.topNode)
}

// 渲染单行行内 Markdown（表格单元格等），不产生块级结构
export function renderInlineMarkdown(src: string, options?: RenderOptions): string {
  const html = renderMarkdown(src, options)
  const m = /^<p>([\s\S]*)<\/p>\n$/.exec(html)
  return m ? m[1] : escapeHtml(src)
}
