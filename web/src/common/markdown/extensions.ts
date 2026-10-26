import type { BlockContext, LeafBlockParser, Line, MarkdownConfig } from '@lezer/markdown'
// Typora extensions: ==highlight==, $inline math$, $$math blocks$$, footnotes, [TOC], and YAML front matter.
// Superscript ^x^, subscript ~x~, and :emoji: use built-in @lezer/markdown extensions.
import { tags } from '@lezer/highlight'
import { inlineStyleSyntax } from './inline-styles'

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1\u2010-\u2027]/

const highlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }

/** ==highlight== uses the same delimiter rules as GFM strikethrough. */
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
 * $inline math$ follows Pandoc rules: no whitespace after the opening $ or before the closing $, and
 * no digit immediately after the closing $. Thus "$5 and $10" is not math; \$ is escaped.
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
          if (ch === 92 /* \ */) {
            i++
          } else if (ch === 36 && i > pos + 1 && !/\s/.test(cx.slice(i - 1, i)) && !/\d/.test(cx.slice(i + 1, i + 2))) {
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
 * Standalone $$ lines delimit math blocks; unclosed blocks extend to the document end. Recognize only top-level blocks: the public parser
 * API cannot tell whether the next line remains in a quote/list container, so nested blocks show source, like tables.
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

/** Footnote references [^label] and definitions [^label]: content; definitions may span lines until a blank line. */
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
          // "[^1]: text" is also a valid link reference definition; run this parser first and remove other continuation candidates to keep the entire block a footnote.
          // Mutate in place because the caller is iterating this array.
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

/** A standalone [TOC], case-insensitively, displays a table of contents. */
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
 * When the first line is ---, YAML front matter runs through the next --- or ... . The parser cannot look ahead
 * through the whole document, so unclosed front matter extends to the end, matching Typora's immediate creation after --- and GitHub/Hugo recognition.
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
