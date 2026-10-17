import { StateEffect, StateField } from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'

// 编辑器焦点状态。块级渲染组件（表格、公式块、Mermaid）由 StateField 提供，拿不到视图的焦点，
// 由视图插件把焦点变化同步进状态：获得焦点且光标在块内时显示源码，否则渲染
// （打开笔记时光标默认在文首，不应因此展开开头的块）
export const setEditorFocus = StateEffect.define<boolean>()

export const editorFocused = StateField.define<boolean>({
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

export const editorFocus = [editorFocused, focusTracker]
