import type { ChangeSpec, EditorState, TransactionSpec } from '@codemirror/state'
// Markdown 格式命令：快捷键与选区工具栏共用
import { EditorSelection } from '@codemirror/state'

/** 只依赖状态与派发，便于在没有 DOM 的环境中测试 */
export interface FormatTarget {
  readonly state: EditorState
  dispatch: (spec: TransactionSpec) => void
}
export type FormatCommand = (target: FormatTarget) => boolean

/**
 * 切换行内标记（粗体 **、斜体 *、删除线 ~~、行内代码 `）：选区两侧或选区首尾已有该标记时去掉，否则加上；
 * 没有选中文字时插入一对标记，光标放在中间
 */
export function toggleInline(mark: string): FormatCommand {
  const n = mark.length
  const ch = mark[0]
  // 选区两侧连续的标记字符数；* 同时用于斜体与粗体：*** 两者都有，单数个才有斜体
  const runLength = (state: EditorState, pos: number, dir: 1 | -1) => {
    let k = 0
    while (state.sliceDoc(dir > 0 ? pos + k : pos - k - 1, dir > 0 ? pos + k + 1 : pos - k) === ch) k++
    return k
  }
  const wrapped = (state: EditorState, from: number, to: number) => {
    const k = Math.min(runLength(state, from, -1), runLength(state, to, 1))
    return mark === '*' ? k % 2 === 1 : k >= n
  }
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((r) => {
      if (wrapped(state, r.from, r.to)) {
        return {
          changes: [
            { from: r.from - n, to: r.from },
            { from: r.to, to: r.to + n },
          ],
          range: EditorSelection.range(r.from - n, r.to - n),
        }
      }
      const text = state.sliceDoc(r.from, r.to)
      if (text.length >= 2 * n && text.startsWith(mark) && text.endsWith(mark)) {
        return { changes: { from: r.from, to: r.to, insert: text.slice(n, -n) }, range: EditorSelection.range(r.from, r.to - 2 * n) }
      }
      return {
        changes: [
          { from: r.from, insert: mark },
          { from: r.to, insert: mark },
        ],
        range: EditorSelection.range(r.from + n, r.to + n),
      }
    })
    dispatch({ ...tr, scrollIntoView: true, userEvent: 'input.format' })
    return true
  }
}

// 行首的块标记：缩进 + 标题 / 任务 / 无序列表 / 有序列表 / 引用（每行只识别一个）
const LINE_PREFIX = /^(\s*)(#{1,6} |[-*+] \[[ x]\] |[-*+] |\d+[.)] |> )?/i

type PrefixKind = 'heading' | 'task' | 'bullet' | 'ordered' | 'quote'

function kindOf(prefix: string): PrefixKind | null {
  if (!prefix) return null
  if (prefix.startsWith('#')) return 'heading'
  if (prefix.startsWith('>')) return 'quote'
  if (/^\d/.test(prefix)) return 'ordered'
  return prefix.includes('[') ? 'task' : 'bullet'
}

/** 改写选区涉及的每一行的行首标记；next 返回新的标记 */
function editPrefixes({ state, dispatch }: FormatTarget, next: (kinds: (PrefixKind | null)[], index: number) => string): boolean {
  const lineNumbers = new Set<number>()
  for (const r of state.selection.ranges) {
    const to = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to
    for (let l = state.doc.lineAt(r.from).number, end = state.doc.lineAt(to).number; l <= end; l++) lineNumbers.add(l)
  }
  const lines = [...lineNumbers].sort((a, b) => a - b).map(l => state.doc.line(l))
  const matches = lines.map(line => LINE_PREFIX.exec(line.text)!)
  const kinds = matches.map(m => kindOf(m[2] ?? ''))
  const specs: ChangeSpec[] = lines.map((line, i) => {
    const from = line.from + matches[i][1].length
    const current = matches[i][2] ?? ''
    return { from, to: from + current.length, insert: next(kinds, i) }
  })
  const changes = state.changes(specs)
  // 光标在行首时随新插入的标记后移；选区则向两端扩展，把新标记包含在内
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => {
      if (r.empty) return EditorSelection.cursor(changes.mapPos(r.head, 1))
      const [lo, hi] = [changes.mapPos(r.from, -1), changes.mapPos(r.to, 1)]
      return r.anchor <= r.head ? EditorSelection.range(lo, hi) : EditorSelection.range(hi, lo)
    }),
    state.selection.mainIndex,
  )
  dispatch({ changes, selection, scrollIntoView: true, userEvent: 'input.format' })
  return true
}

/** 切换列表或引用：所选各行都已是该类型时去掉，否则全部改为该类型（替换原有的其他块标记） */
export function toggleBlock(kind: Exclude<PrefixKind, 'heading'>): FormatCommand {
  return target =>
    editPrefixes(target, (kinds, i) => {
      if (kinds.every(k => k === kind)) return ''
      return { task: '- [ ] ', bullet: '- ', ordered: `${i + 1}. `, quote: '> ' }[kind]
    })
}

/** 标题级别循环：正文 → 一级 → 二级 → 三级 → 正文；以第一行为准 */
export const cycleHeading: FormatCommand = (target) => {
  const first = LINE_PREFIX.exec(target.state.doc.lineAt(target.state.selection.main.from).text)![2] ?? ''
  const level = kindOf(first) === 'heading' ? first.length - 1 : 0
  const prefix = level >= 3 ? '' : `${'#'.repeat(level + 1)} `
  return editPrefixes(target, () => prefix)
}

/** 全部选中行已是指定标题时恢复正文，否则设置为指定级别。 */
export function toggleHeading(level: number): FormatCommand {
  return (target) => {
    const prefix = `${'#'.repeat(level)} `
    const ranges = target.state.selection.ranges
    const lines = new Set<number>()
    for (const range of ranges) {
      const end = range.to > range.from && target.state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to
      for (let n = target.state.doc.lineAt(range.from).number; n <= target.state.doc.lineAt(end).number; n++) lines.add(n)
    }
    const remove = [...lines].every(n => LINE_PREFIX.exec(target.state.doc.line(n).text)![2] === prefix)
    return editPrefixes(target, () => remove ? '' : prefix)
  }
}

/** 插入链接：选中文字作为链接文字，光标放到地址处；没有选中时光标放在文字处 */
export const insertLink: FormatCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((r) => {
    const text = state.sliceDoc(r.from, r.to)
    const insert = `[${text}]()`
    const cursor = text ? r.from + insert.length - 1 : r.from + 1
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(cursor) }
  })
  dispatch({ ...tr, scrollIntoView: true, userEvent: 'input.format' })
  return true
}

export const toggleBold = toggleInline('**')
export const toggleItalic = toggleInline('*')
export const toggleStrike = toggleInline('~~')
export const toggleCode = toggleInline('`')
