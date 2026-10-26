import type { TokenRun } from '@@/highlight/client'
import type { EditorState, Range } from '@codemirror/state'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { cachedTokens, requestTokens } from '@@/highlight/client'
import { syntaxTree } from '@codemirror/language'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'

interface CodeBlock {
  // Document range of code contents, excluding fence lines.
  from: number
  to: number
  lang: string
  code: string
}

const setBlockTokens = StateEffect.define<{ from: number, to: number, decorations: Range<Decoration>[] }>()

// Keep highlighting in a StateField and map positions through edits; retain old colors until the Worker responds to avoid flashing.
const codeTokenField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setBlockTokens)) continue
      value = value.update({
        filterFrom: e.value.from,
        filterTo: e.value.to,
        filter: () => false,
        add: e.value.decorations,
        sort: true,
      })
    }
    return value
  },
  provide: f => EditorView.decorations.from(f),
})

const markCache = new Map<string, Decoration>()

function tokenMark(classes: string): Decoration {
  let deco = markCache.get(classes)
  if (!deco) {
    deco = Decoration.mark({ class: classes })
    markCache.set(classes, deco)
  }
  return deco
}

function tokensToDecorations(block: CodeBlock, run: TokenRun | null): Range<Decoration>[] {
  const out: Range<Decoration>[] = []
  if (!run) return out
  let at = block.from
  function visit(tokens: TokenRun) {
    for (const token of tokens) {
      if (typeof token === 'string') {
        at += token.length
      } else {
        const from = at
        const index = out.length
        visit(token.content)
        if (at > from) out.splice(index, 0, tokenMark(token.classes).range(from, at))
      }
    }
  }
  visit(run)
  return out
}

export function fenceLanguage(state: EditorState, infoFrom: number, infoTo: number): string {
  return state.sliceDoc(infoFrom, infoTo).trim().split(/\s/)[0].toLowerCase()
}

// Fenced-code content range, excluding fence lines; stop before the closing line if present, otherwise at the block end.
export function codeContentRange(state: EditorState, node: SyntaxNode): { from: number, to: number } {
  const open = state.doc.lineAt(node.from)
  const marks = node.getChildren('CodeMark')
  const to = marks.length > 1 ? state.doc.lineAt(node.to).from - 1 : node.to
  return { from: Math.min(open.to + 1, to), to }
}

export function fencedCodeAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'FencedCode') return node
  }
  return null
}

// Ctrl/Cmd+A first selects the current code block's contents; when already selected, defer to normal select-all.
export function selectCodeBlock(view: EditorView): boolean {
  const { state } = view
  const main = state.selection.main
  const node = fencedCodeAt(state, main.head)
  if (!node) return false
  const { from, to } = codeContentRange(state, node)
  if (to <= from || main.head < from || main.head > to || (main.from === from && main.to === to)) return false
  view.dispatch({ selection: { anchor: from, head: to }, userEvent: 'select' })
  return true
}

function visibleCodeBlocks(view: EditorView): CodeBlock[] {
  const { state } = view
  const blocks: CodeBlock[] = []
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'FencedCode') return
        const info = node.node.getChild('CodeInfo')
        if (info) {
          const { from: start, to: end } = codeContentRange(state, node.node)
          if (end > start) {
            blocks.push({ from: start, to: end, lang: fenceLanguage(state, info.from, info.to), code: state.sliceDoc(start, end) })
          }
        }
        return false
      },
    })
  }
  return blocks
}

const codeHighlighter = ViewPlugin.fromClass(
  class {
    // Result keys applied to code blocks, indexed by block start.
    applied = new Map<number, string>()
    destroyed = false

    constructor(readonly view: EditorView) {
      this.schedule()
    }

    update(u: ViewUpdate) {
      if (u.docChanged) {
        const mapped = new Map<number, string>()
        for (const [pos, key] of this.applied) mapped.set(u.changes.mapPos(pos), key)
        this.applied = mapped
      }
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.schedule()
    }

    // Do not dispatch synchronously inside update; defer to a microtask.
    schedule() {
      queueMicrotask(() => this.sync())
    }

    destroy() {
      this.destroyed = true
    }

    sync() {
      if (this.destroyed) return
      const effects: StateEffect<unknown>[] = []
      for (const block of visibleCodeBlocks(this.view)) {
        const key = `${block.lang}\0${block.code}`
        if (this.applied.get(block.from) === key) continue
        const cached = cachedTokens(block.lang, block.code)
        if (cached !== undefined) {
          this.applied.set(block.from, key)
          effects.push(setBlockTokens.of({ from: block.from, to: block.to, decorations: tokensToDecorations(block, cached) }))
        } else {
          // Run sync again when results arrive to hit the cache; changed document keys naturally trigger recalculation.
          requestTokens(block.lang, block.code).then(() => this.schedule()).catch((error) => {
            // Do not retry failed content on every cursor movement; request again after code or language changes.
            if (!this.destroyed) this.applied.set(block.from, key)
            console.error('代码高亮失败', error)
          })
        }
      }
      if (effects.length) this.view.dispatch({ effects })
    }
  },
)

export const codeBlockHighlight = [
  codeTokenField,
  codeHighlighter,
]
