<script setup lang="ts">
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createEditorView } from '../editor'
import { activeTab, attachView, editorStateOf, noteRefOf, storeViewState, ws } from './workspace'

const host = ref<HTMLElement>()
const tab = computed(activeTab)
let view: EditorView
// 当前显示的笔记（以身份对象标识，重命名后不变）及各笔记的滚动位置
let shown: { path: string } | undefined
const scrollTops = new WeakMap<object, number>()

function show() {
  const path = ws.active
  const ref = path ? noteRefOf(path) : undefined
  const state = path ? editorStateOf(path) : undefined
  if (shown && shown !== ref) {
    storeViewState(shown.path, view.state)
    scrollTops.set(shown, view.scrollDOM.scrollTop)
  }
  if (!ref || !state) {
    shown = undefined
    return
  }
  // 切换笔记，或该笔记的状态在别处被整体替换（如恢复草稿）时才重设
  if (shown !== ref || state.doc !== view.state.doc) {
    view.setState(state)
    const top = scrollTops.get(ref) ?? 0
    requestAnimationFrame(() => (view.scrollDOM.scrollTop = top))
  }
  shown = ref
}

onMounted(() => {
  view = createEditorView(host.value!, EditorState.create())
  attachView(view)
  show()
})
onBeforeUnmount(() => {
  if (shown) storeViewState(shown.path, view.state)
  attachView(null)
  view.destroy()
})
watch(() => [ws.active, tab.value?.status], show, { flush: 'post' })
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
