import { describe, expect, it } from 'vitest'
import { setEditorFocus } from './focus'
import { createEditorState } from './index'
import { tableField } from './table'

const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n正文'

describe('表格渲染', () => {
  it('光标在文首但编辑器未聚焦时，开头的表格仍渲染', () => {
    const state = createEditorState({ doc })
    expect(state.selection.main.head).toBe(0)
    expect(state.field(tableField).size).toBe(1)
  })
  it('编辑器聚焦且光标在表格内时显示源码，移出后恢复渲染', () => {
    let state = createEditorState({ doc }).update({ effects: setEditorFocus.of(true) }).state
    expect(state.field(tableField).size).toBe(0)
    state = state.update({ selection: { anchor: doc.length } }).state
    expect(state.field(tableField).size).toBe(1)
  })
})
