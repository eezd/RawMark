import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { undo, redo } from '@codemirror/commands'
import { describe, expect, it } from 'vitest'
import { createEditorState } from './index'
import { applyInlineStyles, canFormatSelection, clearInlineStyles, selectionAppearance, toggleSelectionMark, toggleUnderline } from './inlineStyles'
import { toggleBold, type FormatCommand } from './format'
import { renderMarkdown } from '../markdown/html'

function editor(doc: string, text: string = doc) {
  let state = createEditorState({ doc, extensions: [EditorState.allowMultipleSelections.of(true)] })
  const select = (text: string) => {
    const from = state.doc.toString().indexOf(text)
    if (from < 0) throw new Error('找不到测试选区')
    state = state.update({ selection: EditorSelection.range(from, from + text.length) }).state
  }
  select(text)
  const target = { get state() { return state }, dispatch(spec: TransactionSpec | Transaction) { state = spec instanceof Transaction ? spec.state : state.update(spec).state } }
  return { target, select, run(command: FormatCommand) { return command(target) }, get doc() { return state.doc.toString() } }
}

describe('局部外观', () => {
  it('下划线可切换，并能和 Markdown 粗体叠加', () => {
    const e = editor('hello')
    e.run(toggleUnderline)
    expect(e.doc).toBe('<u>hello</u>')
    expect(selectionAppearance(e.target.state).underline).toBe(true)
    e.run(toggleBold)
    expect(renderMarkdown(e.doc)).toBe('<p><u><strong>hello</strong></u></p>\n')
    e.run(toggleUnderline)
    expect(e.doc).toBe('**hello**')
  })
  it('重复修改同一选区会更新标签，撤销和重做保留选区', () => {
    const e = editor('hello')
    e.run(applyInlineStyles({ color: '#ff0000' }))
    e.run(applyInlineStyles({ color: '#0000ff' }))
    e.run(applyInlineStyles({ 'font-size': '1.5em' }))
    expect(e.doc).toBe('<span style="color: #0000ff; font-size: 1.5em">hello</span>')
    expect(e.target.state.sliceDoc(e.target.state.selection.main.from, e.target.state.selection.main.to)).toBe('hello')
    expect(undo(e.target)).toBe(true)
    expect(redo(e.target)).toBe(true)
    expect(e.doc).toContain('font-size: 1.5em')
  })
  it('修改部分文字，不影响同一标签内其余内容', () => {
    const e = editor('<span style="color: #ff0000">hello world</span>', 'world')
    e.run(applyInlineStyles({ color: '#0000ff' }))
    expect(e.doc).toBe('<span style="color: #ff0000">hello </span><span style="color: #0000ff">world</span>')
    e.run(clearInlineStyles)
    expect(e.doc).toBe('<span style="color: #ff0000">hello </span>world')
  })
  it('跨列表、引用和链接操作保留 Markdown 结构与地址', () => {
    const e = editor('- **one**\n- [two](https://example.com)\n\n> three')
    e.run(applyInlineStyles({ color: '#ff0000' }))
    expect(e.doc).toBe('- <span style="color: #ff0000">**one**</span>\n- [<span style="color: #ff0000">two</span>](https://example.com)\n\n> <span style="color: #ff0000">three</span>')
    e.run(clearInlineStyles)
    expect(e.doc).toBe('- **one**\n- [two](https://example.com)\n\n> three')
  })
  it('清除嵌套外观时保留下划线、高亮和链接', () => {
    const e = editor('<span style="color: #ff0000"><u>==one== <span style="font-size: 20px">[two](https://example.com)</span></u></span>')
    e.run(clearInlineStyles)
    expect(renderMarkdown(e.doc)).toBe('<p><u><mark>one</mark></u><u> </u><a href="https://example.com"><u>two</u></a></p>\n')
  })
  it('代码、公式及 YAML 选区不允许套用样式', () => {
    for (const doc of ['```js\nvalue\n```', '`value`', '$value$', '---\nvalue: true\n---']) {
      const e = editor(doc, 'value')
      expect(canFormatSelection(e.target.state)).toBe(false)
      expect(e.run(toggleUnderline)).toBe(false)
      expect(e.doc).toBe(doc)
    }
  })
  it('反向和多选区保留方向与相互独立的样式', () => {
    const e = editor('one two three')
    e.target.dispatch({ selection: EditorSelection.create([EditorSelection.range(3, 0), EditorSelection.range(8, 13)]) })
    e.run(toggleUnderline)
    expect(e.doc).toBe('<u>one</u> two <u>three</u>')
    expect(e.target.state.selection.main.anchor).toBeGreaterThan(e.target.state.selection.main.head)
  })
  it('未渲染的长文末尾也能格式化；默认外观不制造无效编辑', () => {
    const doc = 'paragraph\n\n'.repeat(3000) + 'lastword'
    const e = editor(doc, 'lastword')
    expect(e.run(clearInlineStyles)).toBe(false)
    e.run(toggleUnderline)
    expect(e.doc).toBe(doc.slice(0, -8) + '<u>lastword</u>')
  })
  it('跨段落的 Markdown 格式逐项切换，保留列表和链接', () => {
    for (const mark of ['StrongEmphasis', 'Emphasis', 'Strikethrough', 'Highlight'] as const) {
      const e = editor('- one\n- [two](https://example.com)\n\n> three')
      e.run(toggleSelectionMark(mark))
      const html = renderMarkdown(e.doc)
      const tag = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 'del', Highlight: 'mark' }[mark]
      expect(html).toContain(`<${tag}>one</${tag}>`)
      expect(html).toContain(`<a href="https://example.com"><${tag}>two</${tag}></a>`)
      e.run(toggleSelectionMark(mark))
      expect(e.doc).toBe('- one\n- [two](https://example.com)\n\n> three')
    }
  })
  it('混合格式选区统一加粗，局部取消不影响剩余文字', () => {
    const e = editor('**one** two')
    e.run(toggleSelectionMark('StrongEmphasis'))
    expect(renderMarkdown(e.doc)).toBe('<p><strong>one</strong> <strong>two</strong></p>\n')
    e.select('two')
    e.run(toggleSelectionMark('StrongEmphasis'))
    expect(renderMarkdown(e.doc)).toBe('<p><strong>one</strong> two</p>\n')
    const whitespace = editor('  alpha  ')
    whitespace.run(toggleSelectionMark('StrongEmphasis'))
    expect(whitespace.doc).toBe('  **alpha**  ')
    expect(whitespace.target.state.sliceDoc(whitespace.target.state.selection.main.from, whitespace.target.state.selection.main.to)).toBe('  **alpha**  ')
  })
  it('多行列表缩进、引用前缀与硬换行保持不变', () => {
    const e = editor('- first  \n  continued\n\n> quote\n> next')
    e.run(applyInlineStyles({ color: '#ff0000' }))
    expect(e.doc).toBe('- <span style="color: #ff0000">first</span>  \n  <span style="color: #ff0000">continued</span>\n\n> <span style="color: #ff0000">quote</span>\n> <span style="color: #ff0000">next</span>')
    const html = renderMarkdown(e.doc)
    expect(html).toContain('<br />')
    expect((html.match(/<li>/g) ?? []).length).toBe(1)
    expect((html.match(/<blockquote>/g) ?? []).length).toBe(1)
  })
  it('局部修改保留同一外层格式内未选代码的样式', () => {
    const bold = editor('**first `code` last**', 'first')
    bold.run(applyInlineStyles({ color: '#0000ff' }))
    expect(renderMarkdown(bold.doc)).toContain('<strong><code>code</code></strong>')
    const color = editor('<span style="color: #ff0000">first `code` last</span>', 'first')
    color.run(applyInlineStyles({ color: '#0000ff' }))
    expect(renderMarkdown(color.doc)).toContain('<span style="color: #ff0000"><code>code</code></span>')
  })
})
