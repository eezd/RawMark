// @vitest-environment happy-dom
import { applyLocale } from '@@/i18n/runtime'
import { undo, undoDepth } from '@codemirror/commands'
import { afterEach, expect, it, vi } from 'vitest'
import { createEditorState, createEditorView } from './index'
import { editorLocale, localeCompartment } from './locale'

const views: ReturnType<typeof createEditorView>[] = []
afterEach(() => {
  views.splice(0).forEach(view => view.destroy())
  document.body.replaceChildren()
  applyLocale('en')
})

it('切换语言更新表格和代码控件，保留正文、选区、撤销历史及缓存状态', () => {
  applyLocale('en')
  const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nlet x = 1\n```\n\nEnd'
  const host = document.createElement('div')
  document.body.append(host)
  const view = createEditorView(host, createEditorState({ doc }))
  views.push(view)
  view.dispatch({ changes: { from: doc.length, insert: '!' }, selection: { anchor: doc.length + 1 } })
  const content = view.state.doc.toString()
  const selection = view.state.selection
  const history = undoDepth(view.state)
  expect(view.dom.querySelector('.cm-rm-code-copy')?.getAttribute('title')).toBe('Copy code')
  expect(view.dom.querySelector('.cm-rm-table-toolbar')?.textContent).toContain('Source')
  let cached = createEditorState({ doc: 'Background note' })
  applyLocale('zh-CN')
  const effects = localeCompartment.reconfigure(editorLocale.of('zh-CN'))
  view.dispatch({ effects })
  cached = cached.update({ effects }).state
  expect(view.state.doc.toString()).toBe(content)
  expect(view.state.selection.eq(selection)).toBe(true)
  expect(undoDepth(view.state)).toBe(history)
  expect(cached.doc.toString()).toBe('Background note')
  expect(cached.facet(editorLocale)).toBe('zh-CN')
  expect(view.dom.querySelector('.cm-rm-code-copy')?.getAttribute('title')).toBe('复制代码')
  expect(view.dom.querySelector('.cm-rm-table-toolbar')?.textContent).toContain('源码')
  expect(undo(view)).toBe(true)
  expect(view.state.doc.toString()).toBe(doc)
})

it('空 Mermaid 提示随语言双向更新，不改正文或撤销历史', async () => {
  applyLocale('en')
  const doc = '```mermaid\n\n```\n\nEnd'
  const host = document.createElement('div')
  document.body.append(host)
  const view = createEditorView(host, createEditorState({ doc }))
  views.push(view)
  view.dispatch({ changes: { from: doc.length, insert: '!' } })
  const content = view.state.doc.toString()
  const history = undoDepth(view.state)
  await vi.waitFor(() => expect(view.dom.querySelector('.cm-rm-mermaid')?.textContent).toBe('Empty diagram'))
  for (const [language, label] of [['zh-CN', '空图表'], ['en', 'Empty diagram']] as const) {
    applyLocale(language)
    view.dispatch({ effects: localeCompartment.reconfigure(editorLocale.of(language)) })
    await vi.waitFor(() => expect(view.dom.querySelector('.cm-rm-mermaid')?.textContent).toBe(label))
    expect(view.state.doc.toString()).toBe(content)
    expect(undoDepth(view.state)).toBe(history)
  }
})
