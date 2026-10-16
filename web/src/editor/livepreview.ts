import { syntaxTree } from '@codemirror/language'
import { Facet, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { fenceLanguage } from './codeblocks'
import { BulletWidget, CheckboxWidget, CodeLangWidget, HorizontalRuleWidget, ImageWidget } from './widgets'

// 把笔记中书写的图片地址解析为浏览器可加载的 URL（相对路径需结合笔记所在目录）
export const resolveImageUrl = Facet.define<(src: string) => string, (src: string) => string>({
  combine: (values) => values[0] ?? ((src) => src),
})

const hidden = Decoration.replace({})
const inlineCode = Decoration.mark({ class: 'cm-rm-inline-code' })
const linkText = Decoration.mark({ class: 'cm-rm-link' })
const lineDecos = new Map<string, Decoration>()

function lineDeco(cls: string): Decoration {
  let deco = lineDecos.get(cls)
  if (!deco) lineDecos.set(cls, (deco = Decoration.line({ class: cls })))
  return deco
}

// 块级标记（标题、引用、列表、围栏）按行展开源码，行内语法只展开光标所在的元素，
// 与 Typora/Obsidian 一致，避免长段落中光标一落整行跳动；编辑器失焦时整篇按渲染效果显示
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>()
  if (!view.hasFocus) return lines
  const { doc } = view.state
  for (const r of view.state.selection.ranges) {
    for (let n = doc.lineAt(r.from).number, end = doc.lineAt(r.to).number; n <= end; n++) lines.add(n)
  }
  return lines
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const { doc } = state
  const active = activeLines(view)
  const resolveUrl = state.facet(resolveImageUrl)
  const out: Range<Decoration>[] = []

  const lineOf = (pos: number) => doc.lineAt(pos).number
  const isActive = (from: number, to = from) => {
    for (let n = lineOf(from), end = lineOf(to); n <= end; n++) if (active.has(n)) return true
    return false
  }
  const ranges = view.hasFocus ? state.selection.ranges : []
  const touches = (node: SyntaxNode) => ranges.some((r) => r.from <= node.to && r.to >= node.from)
  // 视图插件提供的替换装饰不能跨越换行
  const hide = (from: number, to: number) => {
    if (from < to && lineOf(from) === lineOf(to)) out.push(hidden.range(from, to))
  }
  const classLines = (from: number, to: number, cls: (line: number, first: number, last: number) => string) => {
    const first = lineOf(from)
    const last = lineOf(to)
    for (const vr of view.visibleRanges) {
      for (let n = Math.max(first, lineOf(vr.from)), end = Math.min(last, lineOf(vr.to)); n <= end; n++) {
        out.push(lineDeco(cls(n, first, last)).range(doc.line(n).from))
      }
    }
  }
  const spacesAfter = (pos: number) => {
    let end = pos
    while (end < doc.length && state.sliceDoc(end, end + 1) === ' ') end++
    return end
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(ref) {
        const node = ref.node
        const name = node.name
        if (name.startsWith('ATXHeading') || name.startsWith('SetextHeading')) {
          out.push(lineDeco(`cm-rm-h${name.slice(-1)}`).range(doc.lineAt(node.from).from))
          return
        }
        switch (name) {
          case 'HeaderMark': {
            if (isActive(node.from)) return
            const parent = node.parent!
            if (parent.name.startsWith('SetextHeading')) hide(node.from, node.to)
            else if (node.from === parent.from) hide(node.from, spacesAfter(node.to))
            else hide(trailingSpaceStart(state, node.from), node.to)
            return
          }
          case 'EmphasisMark':
          case 'StrikethroughMark':
          case 'SuperscriptMark':
          case 'SubscriptMark':
            if (!touches(node.parent!)) hide(node.from, node.to)
            return
          case 'InlineCode':
            out.push(inlineCode.range(node.from, node.to))
            return
          case 'CodeMark':
            if (node.parent?.name === 'InlineCode' && !touches(node.parent)) hide(node.from, node.to)
            return
          case 'Link':
            decorateLink(node)
            return
          case 'Autolink':
            if (!touches(node)) {
              hide(node.from, node.from + 1)
              hide(node.to - 1, node.to)
            }
            return
          case 'Image':
            decorateImage(node)
            return false
          case 'Escape':
            if (!touches(node)) hide(node.from, node.from + 1)
            return
          case 'HorizontalRule':
            if (!isActive(node.from)) out.push(Decoration.replace({ widget: new HorizontalRuleWidget() }).range(node.from, node.to))
            return
          case 'Blockquote':
            classLines(node.from, node.to, () => 'cm-rm-quote')
            return
          case 'QuoteMark':
            if (!isActive(node.from)) hide(node.from, Math.min(node.to + 1, spacesAfter(node.to)))
            return
          case 'ListMark':
            decorateListMark(node)
            return
          case 'TaskMarker':
            if (!isActive(node.from)) {
              const checked = state.sliceDoc(node.from + 1, node.from + 2) !== ' '
              out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to))
            }
            return
          case 'FencedCode':
            decorateFencedCode(node)
            return false
          case 'CodeBlock':
            classLines(node.from, node.to, () => 'cm-rm-code')
            return false
          case 'Table':
            // 表格可视化编辑在 M2 实现，目前以等宽源码显示，内部语法不做隐藏以免列对不齐
            classLines(node.from, node.to, () => 'cm-rm-table')
            return false
          case 'HTMLBlock':
          case 'CommentBlock':
            return false
        }
      },
    })
  }

  function decorateLink(node: SyntaxNode) {
    const marks = node.getChildren('LinkMark')
    if (marks.length < 2) return
    out.push(linkText.range(marks[0].to, marks[1].from))
    if (touches(node)) return
    hide(marks[0].from, marks[0].to)
    hide(marks[1].from, node.to)
  }

  function decorateImage(node: SyntaxNode) {
    const url = node.getChild('URL')
    const marks = node.getChildren('LinkMark')
    if (!url || marks.length < 2) return
    const src = resolveUrl(state.sliceDoc(url.from, url.to).replace(/^<|>$/g, ''))
    const widget = new ImageWidget(src, state.sliceDoc(marks[0].to, marks[1].from))
    if (touches(node)) out.push(Decoration.widget({ widget, side: 1 }).range(node.to))
    else if (lineOf(node.from) === lineOf(node.to)) out.push(Decoration.replace({ widget }).range(node.from, node.to))
  }

  function decorateListMark(node: SyntaxNode) {
    if (isActive(node.from)) return
    const item = node.parent!
    if (item.getChild('Task')) hide(node.from, spacesAfter(node.to))
    else if (item.parent?.name === 'BulletList') out.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to))
  }

  function decorateFencedCode(node: SyntaxNode) {
    const marks = node.getChildren('CodeMark')
    const closed = marks.length > 1
    classLines(node.from, node.to, (n, first, last) =>
      n === first ? 'cm-rm-code cm-rm-code-begin' : n === last && closed ? 'cm-rm-code cm-rm-code-end' : 'cm-rm-code',
    )
    if (isActive(node.from, node.to)) return
    const info = node.getChild('CodeInfo')
    const openLine = doc.lineAt(node.from)
    const lang = info ? fenceLanguage(state, info.from, info.to) : ''
    out.push(lineDeco('cm-rm-code-fence').range(openLine.from))
    out.push(Decoration.replace({ widget: new CodeLangWidget(lang) }).range(marks[0].from, openLine.to))
    if (closed) {
      const closeMark = marks[marks.length - 1]
      out.push(lineDeco('cm-rm-code-fence').range(doc.lineAt(closeMark.from).from))
      hide(closeMark.from, closeMark.to)
    }
  }

  return Decoration.set(out, true)
}

function trailingSpaceStart(state: EditorState, pos: number): number {
  let start = pos
  while (start > 0 && state.sliceDoc(start - 1, start) === ' ') start--
  return start
}

// Ctrl/Cmd + 点击打开链接
function linkAt(state: EditorState, pos: number): string | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'URL') return state.sliceDoc(node.from, node.to).replace(/^<|>$/g, '')
    if (node.name === 'Link' || node.name === 'Autolink') {
      const url = node.getChild('URL')
      return url ? state.sliceDoc(url.from, url.to).replace(/^<|>$/g, '') : null
    }
  }
  return null
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    // 输入法组字期间只映射位置不重建，组字结束后再补一次重建
    stale = false

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(u: ViewUpdate) {
      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes)
        this.stale = true
        return
      }
      if (
        this.stale ||
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        u.focusChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.stale = false
        this.decorations = buildDecorations(u.view)
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e, view) {
        if (!(e.ctrlKey || e.metaKey)) return false
        const pos = view.posAtCoords(e)
        const href = pos === null ? null : linkAt(view.state, pos)
        if (!href) return false
        e.preventDefault()
        window.open(href, '_blank', 'noopener')
        return true
      },
    },
  },
)

export const livePreview = [livePreviewPlugin]
