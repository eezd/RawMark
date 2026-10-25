import type { EditorState, Range } from '@codemirror/state'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { TokenRun } from '../../../common/highlight/client'
import { syntaxTree } from '@codemirror/language'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import { cachedTokens, requestTokens } from '../../../common/highlight/client'

interface CodeBlock {
  // 代码内容（不含围栏行）在文档中的范围
  from: number
  to: number
  lang: string
  code: string
}

const setBlockTokens = StateEffect.define<{ from: number, to: number, decorations: Range<Decoration>[] }>()

// 高亮结果作为 StateField 保存并随编辑映射位置：Worker 返回新结果前沿用旧颜色，避免闪烁
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

// 围栏代码块的内容范围（不含围栏行）；有闭合围栏时到闭合行之前为止，否则到块尾
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

// Ctrl/Cmd+A：光标在代码块内时先选中整块代码，已选中整块时交给默认的全选
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
    // 已应用到各代码块的结果键，按块起点记录
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

    // 不能在 update 中同步 dispatch，推迟到微任务
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
          // 结果到达后再走一次 sync，届时命中缓存；期间文档若已变化，键不同则自然重算
          requestTokens(block.lang, block.code).then(() => this.schedule()).catch((error) => {
            // 本次内容失败后不随每次光标移动重试，修改代码或语言后重新请求。
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
