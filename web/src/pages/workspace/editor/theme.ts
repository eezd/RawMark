import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

// 编辑器排版样式在 themes/base.css 中以 CSS 变量定义，这里只做语法元素到类名的映射
const markdownHighlight = HighlightStyle.define([
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.processingInstruction, class: 'cm-rm-markup' },
  { tag: [t.url, t.link], class: 'cm-rm-url' },
  { tag: t.quote, class: 'cm-rm-quote-text' },
  { tag: t.monospace, class: 'cm-rm-mono' },
])

export const markdownTheme = syntaxHighlighting(markdownHighlight)
