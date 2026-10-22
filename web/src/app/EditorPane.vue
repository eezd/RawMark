<script setup lang="ts">
import { EditorState, type StateEffect, type Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createEditorView } from '../editor'
import { activeTab, attachView, editorStateOf, noteRefOf, revealPending, storeViewState, ws } from './workspace'

const host = ref<HTMLElement>()
const tab = computed(activeTab)
let view: EditorView
// 当前显示的笔记（以身份对象标识，重命名后不变）及各笔记的滚动位置。
// 优先用滚动快照（锚定文档位置）：重设状态后视口外的行高会重新估算，单靠 scrollTop 会偏移几行；
// 快照只对同一文档有效，笔记在后台被外部修改时退回 scrollTop
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
  // 切换笔记，或该笔记的状态在别处被整体替换（如恢复草稿）时才重设
  if (shown !== ref || state.doc !== view.state.doc) {
    view.setState(state)
    const pos = scrollPositions.get(ref)
    // 等一帧：v-show 在此回调之后才取消 display:none，隐藏状态下无法滚动和聚焦
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
function measure() { view.requestMeasure() }
onBeforeUnmount(() => {
  document.fonts.removeEventListener('loadingdone', measure)
  if (shown) storeViewState(shown.path, view.state)
  attachView(null)
  view.destroy()
})
watch(() => [ws.active, tab.value?.status, ws.view, ws.images], () => { show(); requestAnimationFrame(() => view.requestMeasure()) }, { flush: 'post' })
</script>

<template>
  <div class="rm-editor-pane">
    <div v-show="tab && tab.status !== 'loading' && tab.status !== 'error'" ref="host" class="rm-editor-host" />
    <div v-if="!tab" class="rm-empty">
      <p>选择或新建一篇笔记</p>
    </div>
    <div v-else-if="tab.status === 'error'" class="rm-empty"><p>笔记打开失败</p></div>
  </div>
</template>
