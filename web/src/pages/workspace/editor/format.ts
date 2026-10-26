import type { ChangeSpec, EditorState, TransactionSpec } from '@codemirror/state'
// Markdown formatting commands shared by shortcuts and the selection toolbar.
import { EditorSelection } from '@codemirror/state'

/** Depend only on state and dispatch to allow testing without a DOM. */
export interface FormatTarget {
  readonly state: EditorState
  dispatch: (spec: TransactionSpec) => void
}
export type FormatCommand = (target: FormatTarget) => boolean

/**
 * Toggle inline markers (bold **, italic *, strikethrough ~~, inline code `): remove matching surrounding or edge
 * markers, otherwise add them. With no selection, insert a pair and place the cursor between them.
 */
export function toggleInline(mark: string): FormatCommand {
  const n = mark.length
  const ch = mark[0]
  // Count adjacent marker characters around the selection; * serves italic and bold: *** means both, and only odd counts imply italic.
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

// Leading block marker: indentation plus heading/task/bullet/ordered-list/quote (recognize one per line).
const LINE_PREFIX = /^(\s*)(#{1,6} |[-*+] \[[ x]\] |[-*+] |\d+[.)] |> )?/i

type PrefixKind = 'heading' | 'task' | 'bullet' | 'ordered' | 'quote'

function kindOf(prefix: string): PrefixKind | null {
  if (!prefix) return null
  if (prefix.startsWith('#')) return 'heading'
  if (prefix.startsWith('>')) return 'quote'
  if (/^\d/.test(prefix)) return 'ordered'
  return prefix.includes('[') ? 'task' : 'bullet'
}

/** Rewrite leading markers on every selected line; next returns the new marker. */
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
  // Move a line-start cursor after the inserted marker; expand selections outward to include new markers.
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

/** Toggle a list or quote: remove the type if all selected lines have it; otherwise apply it to all, replacing other block markers. */
export function toggleBlock(kind: Exclude<PrefixKind, 'heading'>): FormatCommand {
  return target =>
    editPrefixes(target, (kinds, i) => {
      if (kinds.every(k => k === kind)) return ''
      return { task: '- [ ] ', bullet: '- ', ordered: `${i + 1}. `, quote: '> ' }[kind]
    })
}

/** Cycle heading levels based on the first line: body -> level 1 -> level 2 -> level 3 -> body. */
export const cycleHeading: FormatCommand = (target) => {
  const first = LINE_PREFIX.exec(target.state.doc.lineAt(target.state.selection.main.from).text)![2] ?? ''
  const level = kindOf(first) === 'heading' ? first.length - 1 : 0
  const prefix = level >= 3 ? '' : `${'#'.repeat(level + 1)} `
  return editPrefixes(target, () => prefix)
}

/** Return to body text if every selected line already has the requested heading level; otherwise apply that level. */
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

/** Insert a link using selected text as its label and focus the destination; without a selection, focus the label. */
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
