import { isolateHistory, redo, undo } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { renderInlineMarkdown } from '../markdown/html'

type Align = '' | 'left' | 'center' | 'right'

interface RowLine {
  from: number
  to: number
  cells: string[]
}

interface TableModel {
  from: number
  to: number
  aligns: Align[]
  // rows[0] 为表头，其余为表体；分隔行单独由 aligns 表示
  rows: RowLine[]
}

// ---- 解析与序列化 ----

// 按未转义的 | 切分一行，去掉首尾可选的竖线
function splitRow(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) {
      cur += ch + line[++i]
    } else if (ch === '|') {
      cells.push(cur)
      cur = ''
    } else cur += ch
  }
  cells.push(cur)
  if (/^\s*$/.test(cells[0]) && line.trimStart().startsWith('|')) cells.shift()
  if (cells.length && /^\s*$/.test(cells[cells.length - 1]) && line.trimEnd().endsWith('|')) cells.pop()
  return cells.map((c) => c.trim())
}

function parseAlign(cell: string): Align {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  return left && right ? 'center' : right ? 'right' : left ? 'left' : ''
}

function escapeCell(text: string): string {
  return text.replace(/\n/g, ' ').replace(/(^|[^\\])\|/g, '$1\\|')
}

function serializeRow(cells: string[]): string {
  return '| ' + cells.join(' | ') + ' |'
}

function serializeDelimiter(aligns: Align[]): string {
  const marks = { '': '---', left: ':---', center: ':---:', right: '---:' }
  return '| ' + aligns.map((a) => marks[a]).join(' | ') + ' |'
}

function serializeTable(aligns: Align[], rows: string[][]): string {
  const [header, ...body] = rows
  return [serializeRow(header), serializeDelimiter(aligns), ...body.map(serializeRow)].join('\n')
}

function readTable(state: EditorState, node: SyntaxNode): TableModel {
  const { doc } = state
  const rows: RowLine[] = []
  let aligns: Align[] = []
  for (let n = doc.lineAt(node.from).number, end = doc.lineAt(node.to).number; n <= end; n++) {
    const line = doc.line(n)
    const cells = splitRow(line.text)
    if (rows.length === 1 && aligns.length === 0) aligns = cells.map(parseAlign)
    else rows.push({ from: line.from, to: line.to, cells })
  }
  const width = aligns.length
  for (const r of rows) {
    r.cells = r.cells.slice(0, width)
    while (r.cells.length < width) r.cells.push('')
  }
  return { from: node.from, to: node.to, aligns, rows }
}

function findTable(state: EditorState, pos: number): SyntaxNode | null {
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === 'Table' && node.from === pos) return node
    if (node.from > pos) break
  }
  return null
}

// ---- 渲染组件 ----

interface WidgetState {
  model: TableModel
  // 最近编辑的单元格，工具栏操作以它为准
  current: { r: number; c: number }
  // 结构变更后需要聚焦的单元格（DOM 重建后生效）
  pendingFocus: { r: number; c: number } | null
}

const widgetStates = new WeakMap<HTMLElement, WidgetState>()

class TableWidget extends WidgetType {
  readonly key: string

  constructor(readonly model: TableModel) {
    super()
    this.key = JSON.stringify([model.aligns, model.rows.map((r) => r.cells)])
  }

  eq(other: TableWidget) {
    return other.key === this.key
  }

  get estimatedHeight() {
    return this.model.rows.length * 34 + 44
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-rm-table-widget'
    widgetStates.set(wrap, { model: this.model, current: { r: 0, c: 0 }, pendingFocus: null })
    // 横向滚动放在内层，避免绝对定位的工具栏被裁剪
    const scroller = document.createElement('div')
    scroller.className = 'cm-rm-table-scroll'
    scroller.append(this.buildTable(view, wrap))
    wrap.append(this.toolbar(view, wrap), scroller)
    return wrap
  }

  updateDOM(dom: HTMLElement, view: EditorView) {
    const st = widgetStates.get(dom)
    if (!st) return false
    const old = st.model
    st.model = this.model
    const sameShape =
      old.rows.length === this.model.rows.length && old.aligns.join() === this.model.aligns.join()
    if (!sameShape || st.pendingFocus) {
      // 重建前记下正在编辑的单元格（如撤销改变了行数），重建后恢复焦点
      const editing = dom.querySelector<HTMLElement>('[contenteditable]')
      const focus =
        st.pendingFocus ?? (editing ? { r: Number(editing.dataset.r), c: Number(editing.dataset.c) } : null)
      st.pendingFocus = null
      dom.querySelector('table')!.replaceWith(this.buildTable(view, dom))
      if (focus) {
        const rows = this.model.rows.length
        const cols = this.model.aligns.length
        const cell = cellAt(dom, Math.min(focus.r, rows - 1), Math.min(focus.c, cols - 1))
        if (cell) startEdit(cell, st)
      }
      return true
    }
    // 形状不变：只刷新内容变化的单元格；正在编辑的单元格若与文档一致则不动，以免打断输入
    dom.querySelectorAll<HTMLElement>('[data-r]').forEach((cell) => {
      const r = Number(cell.dataset.r)
      const c = Number(cell.dataset.c)
      const raw = this.model.rows[r].cells[c]
      if (cell.isContentEditable) {
        if (escapeCell(cell.textContent ?? '') !== raw) {
          cell.textContent = raw
          placeCaretAtEnd(cell)
        }
      } else if (old.rows[r].cells[c] !== raw) cell.innerHTML = renderInlineMarkdown(raw)
    })
    return true
  }

  ignoreEvent() {
    return true
  }

  private buildTable(view: EditorView, wrap: HTMLElement): HTMLTableElement {
    const table = document.createElement('table')
    const thead = table.createTHead()
    const tbody = table.createTBody()
    this.model.rows.forEach((row, r) => {
      const tr = (r === 0 ? thead : tbody).insertRow()
      row.cells.forEach((raw, c) => {
        const cell = document.createElement(r === 0 ? 'th' : 'td')
        cell.dataset.r = String(r)
        cell.dataset.c = String(c)
        if (this.model.aligns[c]) cell.style.textAlign = this.model.aligns[c]
        cell.innerHTML = renderInlineMarkdown(raw)
        bindCell(view, wrap, cell)
        tr.append(cell)
      })
    })
    return table
  }

  private toolbar(view: EditorView, wrap: HTMLElement): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'cm-rm-table-toolbar'
    const tools = document.createElement('div')
    tools.className = 'cm-rm-table-tools'
    bar.append(tools)
    const button = (icon: string, label: string, title: string, run: () => void, danger = false) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.title = title
      if (danger) b.className = 'cm-rm-danger'
      b.innerHTML = svg(icon)
      b.append(label)
      // mousedown 阻止默认行为，保持当前单元格的焦点与光标
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        run()
      })
      tools.append(b)
    }
    const separator = () => {
      const sep = document.createElement('span')
      sep.className = 'cm-rm-sep'
      tools.append(sep)
    }
    button(ICONS.addRow, '行', '在下方插入行', () => insertRow(view, wrap))
    button(ICONS.addColumn, '列', '在右侧插入列', () => insertColumn(view, wrap))
    separator()
    button(ICONS.deleteRow, '行', '删除当前行', () => deleteRow(view, wrap), true)
    button(ICONS.deleteColumn, '列', '删除当前列', () => deleteColumn(view, wrap), true)
    separator()
    button(ICONS.source, '源码', '以 Markdown 源码编辑', () => {
      const model = currentModel(view, wrap)
      if (!model) return
      view.dispatch({ selection: { anchor: model.from } })
      view.focus()
    })
    return bar
  }
}

const ICONS = {
  addRow: '<rect x="3" y="3" width="18" height="8" rx="1.5"/><path d="M12 14v7M8.5 17.5h7"/>',
  addColumn: '<rect x="3" y="3" width="8" height="18" rx="1.5"/><path d="M14 12h7M17.5 8.5v7"/>',
  deleteRow: '<rect x="3" y="3" width="18" height="8" rx="1.5"/><path d="M8.5 17.5h7"/>',
  deleteColumn: '<rect x="3" y="3" width="8" height="18" rx="1.5"/><path d="M14 12h7"/>',
  source: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
}

function svg(body: string): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

// 结构变更：基于文档中的最新表格重新生成整张表的源码，返回变更后应聚焦的单元格
function mutate(
  view: EditorView,
  wrap: HTMLElement,
  f: (rows: string[][], aligns: Align[], cur: { r: number; c: number }) => { r: number; c: number },
) {
  const st = widgetStates.get(wrap)!
  const model = currentModel(view, wrap)
  if (!model) return
  const rows = model.rows.map((r) => [...r.cells])
  const aligns = [...model.aligns]
  st.pendingFocus = f(rows, aligns, st.current)
  // 结构变更单独成为一步撤销，不与前后的单元格输入合并
  view.dispatch({
    changes: { from: model.from, to: model.to, insert: serializeTable(aligns, rows) },
    annotations: isolateHistory.of('full'),
  })
}

// focusColumn 未指定时聚焦新行的同一列
const insertRow = (view: EditorView, wrap: HTMLElement, focusColumn?: number) =>
  mutate(view, wrap, (rows, aligns, cur) => {
    rows.splice(cur.r + 1, 0, aligns.map(() => ''))
    return { r: cur.r + 1, c: focusColumn ?? cur.c }
  })

const insertColumn = (view: EditorView, wrap: HTMLElement) =>
  mutate(view, wrap, (rows, aligns, cur) => {
    const c = cur.c + 1
    aligns.splice(c, 0, '')
    rows.forEach((row) => row.splice(c, 0, ''))
    return { r: cur.r, c }
  })

const deleteRow = (view: EditorView, wrap: HTMLElement) =>
  mutate(view, wrap, (rows, _, cur) => {
    // 表头行不能删除
    if (cur.r === 0) return cur
    rows.splice(cur.r, 1)
    return { r: Math.min(cur.r, rows.length - 1), c: cur.c }
  })

const deleteColumn = (view: EditorView, wrap: HTMLElement) =>
  mutate(view, wrap, (rows, aligns, cur) => {
    if (aligns.length <= 1) return cur
    aligns.splice(cur.c, 1)
    rows.forEach((row) => row.splice(cur.c, 1))
    return { r: cur.r, c: Math.min(cur.c, aligns.length - 1) }
  })

function currentModel(view: EditorView, wrap: HTMLElement): TableModel | null {
  const node = findTable(view.state, view.posAtDOM(wrap))
  return node ? readTable(view.state, node) : null
}

function cellAt(wrap: HTMLElement, r: number, c: number): HTMLElement | null {
  return wrap.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)
}

function placeCaretAtEnd(el: HTMLElement) {
  const sel = el.ownerDocument.getSelection()
  if (!sel) return
  const range = el.ownerDocument.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

// 单元格编辑时显示该格的 Markdown 源码，失焦后恢复渲染
function startEdit(cell: HTMLElement, st: WidgetState) {
  const r = Number(cell.dataset.r)
  const c = Number(cell.dataset.c)
  st.current = { r, c }
  if (!cell.isContentEditable) {
    cell.contentEditable = 'plaintext-only'
    cell.textContent = st.model.rows[r].cells[c]
  }
  cell.focus()
  placeCaretAtEnd(cell)
}

function bindCell(view: EditorView, wrap: HTMLElement, cell: HTMLElement) {
  const st = () => widgetStates.get(wrap)!
  const r = () => Number(cell.dataset.r)
  const c = () => Number(cell.dataset.c)

  cell.addEventListener('mousedown', (e) => {
    if (cell.isContentEditable) return
    e.preventDefault()
    startEdit(cell, st())
  })

  const commit = () => {
    const model = currentModel(view, wrap)
    if (!model) return
    const row = model.rows[r()]
    const cells = [...row.cells]
    const next = escapeCell(cell.textContent ?? '')
    if (cells[c()] === next) return
    cells[c()] = next
    view.dispatch({ changes: { from: row.from, to: row.to, insert: serializeRow(cells) }, userEvent: 'input.type' })
  }

  cell.addEventListener('input', (e) => {
    if (!(e as InputEvent).isComposing) commit()
  })
  cell.addEventListener('compositionend', commit)

  cell.addEventListener('blur', () => {
    cell.removeAttribute('contenteditable')
    cell.innerHTML = renderInlineMarkdown(st().model.rows[r()]?.cells[c()] ?? '')
  })

  const moveTo = (nr: number, nc: number) => {
    const target = cellAt(wrap, nr, nc)
    if (target) startEdit(target, st())
  }

  cell.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    const { rows, aligns } = st().model
    const cols = aligns.length
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      ;(e.shiftKey ? redo : undo)(view)
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo(view)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const idx = r() * cols + c() + (e.shiftKey ? -1 : 1)
      if (idx >= 0 && idx < rows.length * cols) moveTo(Math.floor(idx / cols), idx % cols)
      else if (idx >= rows.length * cols) insertRow(view, wrap, 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (r() + 1 < rows.length) moveTo(r() + 1, c())
      else insertRow(view, wrap)
    } else if (e.key === 'ArrowUp' && r() > 0) {
      e.preventDefault()
      moveTo(r() - 1, c())
    } else if (e.key === 'ArrowDown' && r() + 1 < rows.length) {
      e.preventDefault()
      moveTo(r() + 1, c())
    } else if (e.key === 'Escape') {
      // 退出表格，光标放到表格之后
      e.preventDefault()
      const model = currentModel(view, wrap)
      if (model) view.dispatch({ selection: { anchor: Math.min(model.to + 1, view.state.doc.length) } })
      view.focus()
    }
  })
}

// ---- 装饰 ----

// StateField 拿不到视图的焦点状态，由视图插件把焦点变化同步进状态
const setEditorFocus = StateEffect.define<boolean>()

const editorFocused = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setEditorFocus)) value = e.value
    return value
  },
})

const focusTracker = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.sync()
    }
    update(u: ViewUpdate) {
      if (u.focusChanged) this.sync()
    }
    // 不能在 update 中同步 dispatch，推迟到微任务
    sync() {
      queueMicrotask(() => {
        const focused = this.view.hasFocus
        if (this.view.state.field(editorFocused, false) !== undefined && this.view.state.field(editorFocused) !== focused) {
          this.view.dispatch({ effects: setEditorFocus.of(focused) })
        }
      })
    }
  },
)

// 块级替换装饰跨越多行，只能由 StateField 提供，不能来自 ViewPlugin。
// 与其他语法一致：编辑器获得焦点且光标在表格内时才显示源码（打开笔记时光标默认在文首，不应因此展开开头的表格）
function buildTables(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const sel = state.field(editorFocused) ? state.selection.ranges : []
  // 只渲染顶层表格；引用、列表内的表格以源码显示
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'Table') continue
    if (sel.some((r) => r.from <= node.to && r.to >= node.from)) continue
    const model = readTable(state, node)
    if (model.rows.length === 0 || model.aligns.length === 0) continue
    out.push(Decoration.replace({ widget: new TableWidget(model), block: true }).range(node.from, node.to))
  }
  return Decoration.set(out)
}

export const tableField = StateField.define<DecorationSet>({
  create: buildTables,
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(setEditorFocus)) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state)
    ) {
      return buildTables(tr.state)
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f),
})

export { setEditorFocus }

export const tableEditing = [editorFocused, tableField, focusTracker]
