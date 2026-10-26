import type { EditorView, ViewUpdate } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'

// Editor focus state. StateField-based block widgets (tables, math, Mermaid) cannot access view focus directly,
// so a view plugin syncs focus into state: show source only when focused with the cursor inside the block; otherwise render.
// Opening a note places the cursor at the start and must not expand its first block by itself.
export const setEditorFocus = StateEffect.define<boolean>()

export const editorFocused = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setEditorFocus)) value = e.value
    }
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

    // Do not dispatch synchronously inside update; defer to a microtask.
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
