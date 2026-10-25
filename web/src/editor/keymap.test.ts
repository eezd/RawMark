// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

describe('快捷键', () => {
  it('Windows 上 Ctrl+Y 为重做', async () => {
    // CodeMirror 在模块加载时读取平台，需先设置再导入
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    const { undo } = await import('@codemirror/commands')
    const { EditorView, runScopeHandlers } = await import('@codemirror/view')
    const { createEditorState } = await import('./index')
    const view = new EditorView({ parent: document.body, state: createEditorState({ doc: '' }) })
    view.dispatch({ changes: { from: 0, insert: 'abc' } })
    undo(view)
    expect(view.state.doc.toString()).toBe('')
    const event = new KeyboardEvent('keydown', { key: 'y', code: 'KeyY', keyCode: 89, ctrlKey: true })
    expect(runScopeHandlers(view, event, 'editor')).toBe(true)
    expect(view.state.doc.toString()).toBe('abc')
    view.destroy()
  })
  it('工作区自定义快捷键清空后，不回落到 CM 的缩进或其他冲突绑定', async () => {
    const { EditorView, runScopeHandlers } = await import('@codemirror/view')
    const { createEditorState } = await import('./index')
    const view = new EditorView({ parent: document.body, state: createEditorState({ doc: 'text', shortcuts: [] }) })
    try {
      for (const [key, code] of [['[', 'BracketLeft'], [']', 'BracketRight'], ['i', 'KeyI'], ['/', 'Slash']]) {
        expect(runScopeHandlers(view, new KeyboardEvent('keydown', { key, code, ctrlKey: true }), 'editor')).toBe(false)
      }
      expect(view.state.doc.toString()).toBe('text')
    } finally { view.destroy() }
  })
})
