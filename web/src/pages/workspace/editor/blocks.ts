import type { EditorState, Range } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { codeRenderers, notePath, pluginRefresh } from '@@/plugins/registry'
import { syntaxTree } from '@codemirror/language'
import { StateField } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { codeContentRange, fenceLanguage } from './codeblocks'
import { editorFocused, setEditorFocus } from './focus'
import { editorLocale } from './locale'
import { CodeRendererWidget, MathWidget } from './widgets'

// Math and Mermaid blocks render as replacements while inactive; show source and a live preview below when the cursor enters the block.
// Multiline block replacements must come from StateField; handle only top-level blocks, as with tables.

/** Return block source and its offset from the block start so clicking rendered output places the cursor at the content start. */
function blockContent(state: EditorState, node: SyntaxNode): { text: string, offset: number, language?: string } | null {
  if (node.name === 'BlockMath') {
    const marks = node.getChildren('BlockMathMark')
    const from = state.doc.lineAt(node.from).to + 1
    const to = marks.length > 1 ? state.doc.lineAt(marks[marks.length - 1].from).from - 1 : node.to
    return { text: from <= to ? state.sliceDoc(from, to) : '', offset: Math.min(from, node.to) - node.from }
  }
  if (node.name === 'FencedCode') {
    const info = node.getChild('CodeInfo')
    if (!info) return null
    const language = fenceLanguage(state, info.from, info.to).toLowerCase()
    if (!codeRenderers.has(language)) return null
    const { from, to } = codeContentRange(state, node)
    return { text: state.sliceDoc(from, to), offset: from - node.from, language }
  }
  return null
}

function buildBlocks(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const sel = state.field(editorFocused) ? state.selection.ranges : []
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    const content = blockContent(state, node)
    if (!content) continue
    const editing = sel.some(r => r.from <= node.to && r.to >= node.from)
    const widget = (editOffset: number | null) =>
      node.name === 'BlockMath' ? new MathWidget(content.text, true, editOffset) : new CodeRendererWidget(content.text, editOffset, content.language!, state.facet(notePath).path, codeRenderers.get(content.language!)!)
    if (editing) out.push(Decoration.widget({ widget: widget(null), block: true, side: 1 }).range(node.to))
    else out.push(Decoration.replace({ widget: widget(content.offset), block: true }).range(node.from, node.to))
  }
  return Decoration.set(out)
}

export const renderedBlocks = StateField.define<DecorationSet>({
  create: buildBlocks,
  update(value, tr) {
    if (
      tr.startState.facet(editorLocale) !== tr.state.facet(editorLocale)
      || tr.docChanged
      || tr.selection
      || tr.effects.some(e => e.is(setEditorFocus) || e.is(pluginRefresh))
      || syntaxTree(tr.startState) !== syntaxTree(tr.state)
    ) {
      return buildBlocks(tr.state)
    }
    return value
  },
  provide: f => EditorView.decorations.from(f),
})
