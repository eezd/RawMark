import { syntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { cachedTokens, requestTokens, type TokenRun } from '../highlight/client'

interface CodeBlock {
  // 代码内容（不含围栏行）在文档中的范围
  from: number
  to: number
  lang: string
  code: string
}

const setBlockTokens = StateEffect.define<{ from: number; to: number; decorations: Range<Decoration>[] }>()

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
  provide: (f) => EditorView.decorations.from(f),
})

const markCache = new Map<string, Decoration>()

function tokenMark(color: string, fontStyle: number): Decoration {
  const key = color + '|' + fontStyle
  let deco = markCache.get(key)
  if (!deco) {
    let style = color ? `color:${color}` : ''
    if (fontStyle & 1) style += ';font-style:italic'
    if (fontStyle & 2) style += ';font-weight:bold'
    if (fontStyle & 4) style += ';text-decoration:underline'
    deco = Decoration.mark({ attributes: { style } })
    markCache.set(key, deco)
  }
  return deco
}

function tokensToDecorations(block: CodeBlock, run: TokenRun | null): Range<Decoration>[] {
  const out: Range<Decoration>[] = []
  if (!run) return out
  for (let i = 0; i < run.length; i += 4) {
    const from = block.from + (run[i] as number)
    out.push(tokenMark(run[i + 2] as string, run[i + 3] as number).range(from, from + (run[i + 1] as number)))
  }
  return out
}

export function fenceLanguage(state: EditorState, infoFrom: number, infoTo: number): string {
  return state.sliceDoc(infoFrom, infoTo).trim().split(/\s/)[0].toLowerCase()
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
          const open = state.doc.lineAt(node.from)
          const close = state.doc.lineAt(node.to)
          const marks = node.node.getChildren('CodeMark')
          // 有闭合围栏时内容到闭合行之前为止，否则到块尾
          const end = marks.length > 1 ? close.from - 1 : node.to
          const start = Math.min(open.to + 1, end)
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
        const key = block.lang + '\0' + block.code
        if (this.applied.get(block.from) === key) continue
        const cached = cachedTokens(block.lang, block.code)
        if (cached !== undefined) {
          this.applied.set(block.from, key)
          effects.push(setBlockTokens.of({ from: block.from, to: block.to, decorations: tokensToDecorations(block, cached) }))
        } else {
          // 结果到达后再走一次 sync，届时命中缓存；期间文档若已变化，键不同则自然重算
          requestTokens(block.lang, block.code).then(() => this.schedule())
        }
      }
      if (effects.length) this.view.dispatch({ effects })
    }
  },
)

export const codeBlockHighlight = [codeTokenField, codeHighlighter]
