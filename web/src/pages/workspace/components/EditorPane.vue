<script setup lang="ts">
import type { StateEffect, Text } from '@codemirror/state'

import type { EditorView } from '@codemirror/view'
import { t as translate } from '@@/i18n/runtime'
import { EditorState } from '@codemirror/state'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createEditorView } from '../editor'
import { activeTab, attachView, editorStateOf, noteRefOf, revealPending, storeViewState, ws } from '../workspace'

const host = ref<HTMLElement>()
const tab = computed(activeTab)
let view: EditorView
// The displayed note (identified by an identity object that survives renaming) and each note's scroll position.
// Prefer document-anchored scroll snapshots: resetting state reestimates offscreen line heights, so scrollTop alone may drift by several lines.
// Snapshots apply only to the same document; fall back to scrollTop when external changes update a background note.
interface ScrollPosition {
  doc: Text
  snapshot: StateEffect<unknown>
  top: number
}
let shown: { path: string } | undefined
const scrollPositions = new WeakMap<object, ScrollPosition>()

function show() {
  const path = ws.active
  const ref = path ? noteRefOf(path) : undefined
  const state = path ? editorStateOf(path) : undefined
  if (shown && shown !== ref) {
    storeViewState(shown.path, view.state)
    scrollPositions.set(shown, { doc: view.state.doc, snapshot: view.scrollSnapshot(), top: view.scrollDOM.scrollTop })
  }
  if (!ref || !state) {
    shown = undefined
    return
  }
  // Reset only on note switches or when another operation replaces the entire state, such as draft restoration.
  if (shown !== ref || state.doc !== view.state.doc) {
    view.setState(state)
    const pos = scrollPositions.get(ref)
    // Wait one frame: v-show removes display:none after this callback, and hidden elements cannot scroll or focus.
    requestAnimationFrame(() => {
      if (shown !== ref || revealPending(view, ref.path)) return
      if (pos?.doc === view.state.doc) view.dispatch({ effects: pos.snapshot })
      else view.scrollDOM.scrollTop = pos?.top ?? 0
    })
  }
  shown = ref
}

onMounted(() => {
  view = createEditorView(host.value!, EditorState.create())
  attachView(view)
  document.fonts.addEventListener('loadingdone', measure)
  show()
})
function measure() {
  view.requestMeasure()
}
onBeforeUnmount(() => {
  document.fonts.removeEventListener('loadingdone', measure)
  if (shown) storeViewState(shown.path, view.state)
  attachView(null)
  view.destroy()
})
watch(() => [ws.active, tab.value?.status, ws.view, ws.images], () => {
  show(); requestAnimationFrame(() => view.requestMeasure())
}, { flush: 'post' })
</script>

<template>
  <div class="rm-editor-pane">
    <div v-show="tab && tab.status !== 'loading' && tab.status !== 'error'" ref="host" class="rm-editor-host" />
    <div v-if="!tab" class="rm-empty">
      <p>{{ translate('workspace.select_or_create_a_note_669f82') }}</p>
    </div>
    <div v-else-if="tab.status === 'loading'" class="rm-empty" role="status">
      <p>{{ translate('workspace.loading_4927a5') }}</p>
    </div>
    <div v-else-if="tab.status === 'error'" class="rm-empty">
      <p>{{ translate('workspace.could_not_open_this_note_634236') }}</p>
    </div>
  </div>
</template>
