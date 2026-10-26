import type { InlineStyles } from '@@/markdown/inline-styles'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import type { FormatCommand } from './format'
import { inlineStyleText, stylesFromTag } from '@@/markdown/inline-styles'
import { ensureSyntaxTree, language } from '@codemirror/language'
import { EditorSelection } from '@codemirror/state'

interface Wrapper { marks: { from: number, to: number }[] }
interface Segment {
  from: number
  to: number
  atomic: boolean
  styles: InlineStyles
  underline: boolean
  formats: string[]
  wrappers: Wrapper[]
}
const TEXT_CONTAINERS = new Set(['Paragraph', 'TableCell', 'Emphasis', 'StrongEmphasis', 'Strikethrough', 'Highlight', 'Superscript', 'Subscript', 'Underline', 'InlineStyle'])
const PROTECTED = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'InlineMath', 'BlockMath', 'FrontMatter', 'HTMLBlock', 'Image'])
type InlineMark = 'StrongEmphasis' | 'Emphasis' | 'Strikethrough' | 'Highlight'
const MARKS: Record<InlineMark, string> = { StrongEmphasis: '**', Emphasis: '*', Strikethrough: '~~', Highlight: '==' }
const MARK_NODES: Record<InlineMark, string> = { StrongEmphasis: 'EmphasisMark', Emphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark', Highlight: 'HighlightMark' }

function formattingTree(state: EditorState) {
  const to = state.selection.ranges.at(-1)!.to
  // Selections in background tabs or near long-document ends may not be fully parsed; operations must not silently skip text.
  return ensureSyntaxTree(state, to, 50) ?? state.facet(language)!.parser.parse(state.doc.toString())
}

/** Extract text fragments from the current syntax tree, preserving Markdown markers, link destinations, and block structure. */
function segments(state: EditorState): Segment[] {
  const result: Segment[] = []
  function walk(node: SyntaxNode, styles: InlineStyles = {}, underline = false, formats: string[] = [], wrappers: Wrapper[] = []) {
    if (['InlineCode', 'InlineMath', 'Image', 'FootnoteReference', 'Emoji', 'Autolink', 'Escape', 'Entity'].includes(node.name)) {
      // Do not split atomic syntax; when changing sibling text under the same outer tag, preserve styles on these unselected fragments.
      result.push({ from: node.from, to: node.to, atomic: true, styles, underline, formats, wrappers })
      return
    }
    if (PROTECTED.has(node.name)) return
    if (node.name === 'InlineStyle' || node.name === 'Underline') {
      const marks = node.getChildren(`${node.name}Mark`)
      if (node.name === 'InlineStyle') styles = { ...styles, ...stylesFromTag(state.sliceDoc(marks[0].from, marks[0].to)) }
      else underline = true
      wrappers = [...wrappers, { marks }]
    }
    if (node.name in MARKS) {
      formats = [...formats, node.name]
      wrappers = [...wrappers, { marks: node.getChildren(MARK_NODES[node.name as InlineMark]) }]
    }
    if (node.name === 'Link') formats = [...formats, 'Link']
    const textContainer = TEXT_CONTAINERS.has(node.name) || /^(ATX|Setext)Heading\d$/.test(node.name) || node.name === 'Link'
    const add = (from: number, to: number) => {
      for (const match of state.sliceDoc(from, to).matchAll(/[^\n]+/g)) {
        const start = from + match.index; const end = start + match[0].length
        const line = state.doc.lineAt(start)
        // Continuation lines can still have list indentation or quote prefixes; insert tags after the prefix.
        const prefixEnd = line.from + /^(?:[\t ]*>[\t ]?)*[\t ]*/.exec(line.text)![0].length
        const contentFrom = Math.max(start, prefixEnd)
        if (contentFrom < end) result.push({ from: contentFrom, to: end, atomic: false, styles, underline, formats, wrappers })
      }
    }
    let pos = node.from
    let end = node.to
    if (node.name === 'Link') {
      const marks = node.getChildren('LinkMark')
      pos = marks[0].to
      end = marks.find(mark => state.sliceDoc(mark.from, mark.to) === ']')!.from
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.to <= pos || child.from >= end) continue
      if (textContainer && child.from > pos) add(pos, child.from)
      walk(child, styles, underline, formats, wrappers)
      pos = child.to
    }
    if (textContainer && pos < end) add(pos, end)
  }
  walk(formattingTree(state).topNode)
  return result
}

export function canFormatSelection(state: EditorState): boolean {
  if (state.selection.main.empty) return false
  let allowed = true
  for (const range of state.selection.ranges) {
    formattingTree(state).iterate({ from: range.from, to: range.to, enter(node) {
      if (range.from < node.to && range.to > node.from && PROTECTED.has(node.name)) {
        allowed = false; return false
      }
    } })
  }
  return allowed
}

function selected(state: EditorState, segment: Segment) {
  return state.selection.ranges.some(range => range.from < segment.to && range.to > segment.from)
}

export function selectionAppearance(state: EditorState) {
  const runs = segments(state).filter(segment => selected(state, segment))
  const styles: InlineStyles = { ...runs[0]?.styles }
  for (const key of Object.keys(styles) as (keyof InlineStyles)[]) {
    if (runs.some(run => run.styles[key] !== styles[key])) delete styles[key]
  }
  const all = (format: string) => runs.length > 0 && runs.every(run => run.formats.includes(format))
  return { styles, underline: runs.length > 0 && runs.every(run => run.underline), bold: all('StrongEmphasis'), italic: all('Emphasis'), strike: all('Strikethrough'), highlight: all('Highlight'), link: all('Link') }
}

function wrap(text: string, styles: InlineStyles, underline: boolean, formats: string[]) {
  const css = inlineStyleText(styles)
  const leading = text.match(/^\s*/u)![0]; const trailing = text.match(/\s*$/u)![0]
  const content = text.slice(leading.length, text.length - trailing.length)
  const marks = content ? (['Strikethrough', 'Highlight', 'StrongEmphasis', 'Emphasis'] as const).filter(mark => formats.includes(mark)).map(mark => MARKS[mark]) : []
  const open = marks.join(''); const close = marks.reverse().join('')
  const prefix = (css ? `<span style="${css}">` : '') + (underline ? '<u>' : '')
  return { prefix, leading: leading.length, trailing: trailing.length, marks: open.length, text: prefix + (content ? leading + open + content + close + trailing : text) + (underline ? '</u>' : '') + (css ? '</span>' : '') }
}

/** Rewrite only selected text and surrounding appearance tags; retain styles on remaining split fragments. */
function editAppearance(update: (styles: InlineStyles, underline: boolean, formats: string[]) => { styles: InlineStyles, underline: boolean, formats: string[] }): FormatCommand {
  return ({ state, dispatch }) => {
    if (!canFormatSelection(state)) return false
    const runs = segments(state)
    const affected = runs.filter(run => selected(state, run))
    const wrappers = new Set(affected.flatMap(run => run.wrappers))
    const changes: { from: number, to: number, insert: string }[] = []
    const offsets: { from: number, to: number, start: number, leading: number, trailing: number, marks: number, changeFrom: number }[] = []
    for (const wrapper of wrappers) {
      for (const mark of wrapper.marks) changes.push({ from: mark.from, to: mark.to, insert: '' })
    }
    for (const run of runs) {
      if (!selected(state, run) && !run.wrappers.some(wrapper => wrappers.has(wrapper))) continue
      // Expand sibling tags within the same outer tag too, then write back merged effective styles.
      for (const wrapper of run.wrappers) {
        if (!wrappers.has(wrapper)) {
          wrappers.add(wrapper)
          for (const mark of wrapper.marks) changes.push({ from: mark.from, to: mark.to, insert: '' })
        }
      }
      // Partial selections of atomic syntax, such as escapes, format the whole unit; never insert tags inside the syntax.
      const cuts = run.atomic ? [run.from, run.to] : [...new Set([run.from, run.to, ...state.selection.ranges.flatMap(range => [Math.max(run.from, Math.min(run.to, range.from)), Math.max(run.from, Math.min(run.to, range.to))])])].sort((a, b) => a - b)
      let insert = ''
      for (let i = 0; i < cuts.length - 1; i++) {
        const from = cuts[i]; const to = cuts[i + 1]
        const next = selected(state, { ...run, from, to }) ? update({ ...run.styles }, run.underline, run.formats) : run
        const part = wrap(state.sliceDoc(from, to), next.styles, next.underline, next.formats)
        offsets.push({ from, to, start: insert.length + part.prefix.length, leading: part.leading, trailing: part.trailing, marks: part.marks, changeFrom: run.from })
        insert += part.text
      }
      if (insert !== state.sliceDoc(run.from, run.to)) changes.push({ from: run.from, to: run.to, insert })
    }
    if (!changes.length) return false
    const changeSet = state.changes(changes.sort((a, b) => a.from - b.from))
    const mapped = (pos: number, end: boolean) => {
      const piece = offsets.find(piece => end ? piece.from < pos && pos <= piece.to : piece.from <= pos && pos < piece.to)
      if (!piece) return changeSet.mapPos(pos, end ? -1 : 1)
      const relative = pos - piece.from; const bodyEnd = piece.to - piece.from - piece.trailing
      const marks = relative < piece.leading || (end && relative === piece.leading)
        ? 0
        : relative > bodyEnd || (!end && relative === bodyEnd) ? piece.marks * 2 : piece.marks
      return changeSet.mapPos(piece.changeFrom, -1) + piece.start + relative + marks
    }
    const selection = EditorSelection.create(state.selection.ranges.map((range) => {
      const from = mapped(range.from, false); const to = mapped(range.to, true)
      return range.anchor <= range.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from)
    }), state.selection.mainIndex)
    dispatch({ changes: changeSet, selection, scrollIntoView: true, userEvent: 'input.format' })
    return true
  }
}

export function applyInlineStyles(patch: InlineStyles): FormatCommand {
  return editAppearance((styles, underline, formats) => {
    for (const [key, value] of Object.entries(patch) as [keyof InlineStyles, string | undefined][]) {
      if (value) styles[key] = value
      else delete styles[key]
    }
    return { styles, underline, formats }
  })
}
export const clearInlineStyles = editAppearance((_styles, underline, formats) => ({ styles: {}, underline, formats }))
export const toggleUnderline: FormatCommand = (target) => {
  const remove = selectionAppearance(target.state).underline
  return editAppearance((styles, _underline, formats) => ({ styles, underline: !remove, formats }))(target)
}

/** Format across paragraphs by syntax fragment, without wrapping list markers or link destinations in Markdown delimiters. */
export function toggleSelectionMark(mark: InlineMark): FormatCommand {
  return (target) => {
    const runs = segments(target.state).filter(run => selected(target.state, run))
    const remove = runs.length > 0 && runs.every(run => run.formats.includes(mark))
    return editAppearance((styles, underline, formats) => ({ styles, underline, formats: remove ? formats.filter(value => value !== mark) : [...new Set([...formats, mark])] }))(target)
  }
}
