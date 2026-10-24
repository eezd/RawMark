// Typora 扩展语法：==高亮==、$行内公式$、$$公式块$$、脚注、[TOC]、YAML front matter。
// 上标 ^x^、下标 ~x~、:emoji: 由 @lezer/markdown 自带的扩展解析
import { tags } from '@lezer/highlight'
import type { BlockContext, LeafBlockParser, Line, MarkdownConfig } from '@lezer/markdown'
import { inlineStyleSyntax } from './inlineStyles'

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1‐-‧]/

const highlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }

/** ==高亮==，定界规则与 GFM 删除线相同 */
const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': tags.special(tags.content) } },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1
        const before = cx.slice(pos - 1, pos)
        const after = cx.slice(pos + 2, pos + 3)
        const sBefore = /\s|^$/.test(before)
        const sAfter = /\s|^$/.test(after)
        const pBefore = PUNCTUATION.test(before)
        const pAfter = PUNCTUATION.test(after)
        return cx.addDelimiter(
          highlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        )
      },
      after: 'Emphasis',
    },
  ],
}

/**
 * $行内公式$（Pandoc 规则）：开头 $ 后不能是空白，结尾 $ 前不能是空白、后面不能紧跟数字，
 * 因此"$5 和 $10"这类金额不会被当成公式；\$ 为转义
 */
const InlineMath: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: tags.monospace },
    { name: 'InlineMathMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== 36 /* $ */ || cx.char(pos + 1) === 36 || /\s/.test(cx.slice(pos + 1, pos + 2))) return -1
        for (let i = pos + 1; i < cx.end; i++) {
          const ch = cx.char(i)
          if (ch === 92 /* \ */) i++
          else if (ch === 36 && i > pos + 1 && !/\s/.test(cx.slice(i - 1, i)) && !/\d/.test(cx.slice(i + 1, i + 2))) {
            return cx.addElement(cx.elt('InlineMath', pos, i + 1, [cx.elt('InlineMathMark', pos, pos + 1), cx.elt('InlineMathMark', i, i + 1)]))
          }
        }
        return -1
      },
      before: 'Emphasis',
    },
  ],
}

const isMathFence = (line: Line) => /^\$\$\s*$/.test(line.text.slice(line.pos))

/**
 * 独占一行的 $$ 之间为公式块，未闭合时延续到文档末尾。只在顶层识别：解析器的公开接口无法判断
 * 下一行是否仍属于引用、列表等容器，与表格一样，容器内的公式块以源码显示
 */
const BlockMath: MarkdownConfig = {
  defineNodes: [
    { name: 'BlockMath', block: true, style: tags.monospace },
    { name: 'BlockMathMark', style: tags.processingInstruction },
  ],
  parseBlock: [
    {
      name: 'BlockMath',
      parse(cx, line) {
        if (cx.parentType().name !== 'Document' || !isMathFence(line)) return false
        const from = cx.lineStart + line.pos
        const marks = [cx.elt('BlockMathMark', from, from + 2)]
        while (cx.nextLine()) {
          if (isMathFence(line)) {
            marks.push(cx.elt('BlockMathMark', cx.lineStart + line.pos, cx.lineStart + line.pos + 2))
            cx.nextLine()
            break
          }
        }
        cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd(), marks))
        return true
      },
      endLeaf: (cx, line) => cx.parentType().name === 'Document' && isMathFence(line),
      before: 'FencedCode',
    },
  ],
}

const FOOTNOTE_LABEL = /^\[\^([^\]\s]+)\]/

/** 脚注引用 [^label] 与脚注定义 [^label]: 内容（定义可跨行，直到空行） */
const Footnote: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteReference', style: tags.labelName },
    { name: 'FootnoteDefinition', block: true },
    { name: 'FootnoteLabel', style: tags.labelName },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 94 /* ^ */) return -1
        const m = FOOTNOTE_LABEL.exec(cx.slice(pos, cx.end))
        return m ? cx.addElement(cx.elt('FootnoteReference', pos, pos + m[0].length)) : -1
      },
      before: 'Link',
    },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      leaf(_cx, leaf) {
        const m = /^\[\^[^\]\s]+\]:/.exec(leaf.content)
        if (!m) return null
        const self: LeafBlockParser = {
          // "[^1]: 文字"同时也是合法的链接引用定义；本解析器排在前面，续行时去掉其他候选，整块归为脚注定义。
          // 须原地修改：调用方正在遍历这个数组
          nextLine(_cx, _line, leaf) {
            leaf.parsers.splice(0, leaf.parsers.length, self)
            return false
          },
          finish(cx, leaf) {
            const label = cx.elt('FootnoteLabel', leaf.start, leaf.start + m[0].length)
            const body = cx.parser.parseInline(leaf.content.slice(m[0].length), leaf.start + m[0].length)
            cx.addLeafElement(leaf, cx.elt('FootnoteDefinition', leaf.start, leaf.start + leaf.content.length, [label, ...body]))
            return true
          },
        }
        return self
      },
      before: 'LinkReference',
    },
  ],
}

/** 独占一行的 [TOC]（不区分大小写）显示为目录 */
const TableOfContents: MarkdownConfig = {
  defineNodes: [{ name: 'TableOfContents', block: true, style: tags.meta }],
  parseBlock: [
    {
      name: 'TableOfContents',
      parse(cx, line) {
        if (!/^\[toc\]\s*$/i.test(line.text.slice(line.pos))) return false
        cx.addElement(cx.elt('TableOfContents', cx.lineStart + line.pos, cx.lineStart + line.text.length))
        cx.nextLine()
        return true
      },
      before: 'LinkReference',
    },
  ],
}

const isFrontMatterEnd = (line: Line) => /^(---|\.\.\.)\s*$/.test(line.text)

/**
 * 文档首行为 --- 时，到下一个 --- 或 ... 为 YAML front matter。解析器无法向后预读整个文档，
 * 未闭合时延续到文末——与 Typora（首行输入 --- 即创建 front matter）及 GitHub、Hugo 的识别方式一致
 */
const FrontMatter: MarkdownConfig = {
  defineNodes: [
    { name: 'FrontMatter', block: true, style: tags.monospace },
    { name: 'FrontMatterMark', style: tags.processingInstruction },
  ],
  parseBlock: [
    {
      name: 'FrontMatter',
      parse(cx: BlockContext, line: Line) {
        if (cx.lineStart !== 0 || cx.parentType().name !== 'Document' || !/^---\s*$/.test(line.text)) return false
        const marks = [cx.elt('FrontMatterMark', 0, 3)]
        while (cx.nextLine()) {
          if (isFrontMatterEnd(line)) {
            marks.push(cx.elt('FrontMatterMark', cx.lineStart, cx.lineStart + 3))
            cx.nextLine()
            break
          }
        }
        cx.addElement(cx.elt('FrontMatter', 0, cx.prevLineEnd(), marks))
        return true
      },
      before: 'HorizontalRule',
    },
  ],
}

export const typoraExtensions: MarkdownConfig[] = [FrontMatter, Highlight, InlineMath, BlockMath, Footnote, TableOfContents, inlineStyleSyntax]
