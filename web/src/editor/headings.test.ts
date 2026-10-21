import { EditorState } from '@codemirror/state'
import { expect, it } from 'vitest'
import { toggleHeading } from './format'

it('标题快捷键设置六级标题，同级再次执行恢复正文，选区末端不修改下一行', () => {
  let state = EditorState.create({ doc: '第一行\n第二行', selection: { anchor: 0, head: 4 } })
  const target = { get state() { return state }, dispatch: (spec: Parameters<EditorState['update']>[0]) => { state = state.update(spec).state } }
  toggleHeading(6)(target)
  expect(state.doc.toString()).toBe('###### 第一行\n第二行')
  toggleHeading(6)(target)
  expect(state.doc.toString()).toBe('第一行\n第二行')
})
