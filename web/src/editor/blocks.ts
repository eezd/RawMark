import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { codeContentRange, fenceLanguage } from './codeblocks'
import { editorFocused, setEditorFocus } from './focus'
import { MathWidget, MermaidWidget } from './widgets'

// 公式块与 Mermaid 图表：未编辑时整块替换为渲染结果；光标在块内时显示源码，并在下方实时预览。
// 跨行的块级替换只能由 StateField 提供；与表格一样只处理顶层的块

/** 返回块的源码内容及其相对块起点的偏移（点击渲染结果时光标落在内容开头） */
function blockContent(state: EditorState, node: SyntaxNode): { text: string; offset: number } | null {
  if (node.name === 'BlockMath') {
    const marks = node.getChildren('BlockMathMark')
    const from = state.doc.lineAt(node.from).to + 1
    const to = marks.length > 1 ? state.doc.lineAt(marks[marks.length - 1].from).from - 1 : node.to
    return { text: from <= to ? state.sliceDoc(from, to) : '', offset: Math.min(from, node.to) - node.from }
  }
  if (node.name === 'FencedCode') {
    const info = node.getChild('CodeInfo')
    if (!info || fenceLanguage(state, info.from, info.to) !== 'mermaid') return null
    const { from, to } = codeContentRange(state, node)
    return { text: state.sliceDoc(from, to), offset: from - node.from }
  }
  return null
}

function buildBlocks(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const sel = state.field(editorFocused) ? state.selection.ranges : []
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    const content = blockContent(state, node)
    if (!content) continue
    const editing = sel.some((r) => r.from <= node.to && r.to >= node.from)
    const widget = (editOffset: number | null) =>
      node.name === 'BlockMath' ? new MathWidget(content.text, true, editOffset) : new MermaidWidget(content.text, editOffset)
    if (editing) out.push(Decoration.widget({ widget: widget(null), block: true, side: 1 }).range(node.to))
    else out.push(Decoration.replace({ widget: widget(content.offset), block: true }).range(node.from, node.to))
  }
  return Decoration.set(out)
}

export const renderedBlocks = StateField.define<DecorationSet>({
  create: buildBlocks,
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setEditorFocus)) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
    ) {
      return buildBlocks(tr.state)
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f),
})
