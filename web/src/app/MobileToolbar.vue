<script setup lang="ts">
import { redo, undo } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cycleHeading, insertLink, toggleBlock, toggleBold, toggleCode, toggleItalic, toggleStrike, toggleInline } from '../editor/format'
import Icon, { type IconName } from './Icon.vue'
import { settings } from './settings'
import { activeTab, onEditorUpdate, ws, editorView, insertImagesFromPicker } from './workspace'

// 底部格式栏与选区工具条；触屏设备仅在编辑器获得焦点时显示底栏。
// 按钮在 mousedown 时阻止默认行为，焦点留在编辑器中，键盘不会收起
// （不能在 pointerdown 上阻止：WebKit 会因此不再触发 click）
const visible = ref(false)
const floatingToolbar = ref<HTMLDivElement>()
const floating = ref<{ left: number; top: number } | null>(null)
let unsubscribe: (() => void) | undefined
const coarse = matchMedia('(pointer: coarse)')

const FORMAT_BUTTONS: { icon: IconName; title: string; run: (v: EditorView) => unknown }[] = [
  { icon: 'task', title: '任务列表', run: toggleBlock('task') },
  { icon: 'quote', title: '引用', run: toggleBlock('quote') },
  { icon: 'link', title: '链接', run: insertLink },
  { icon: 'image', title: '插入图片', run: () => insertImagesFromPicker() },
  { icon: 'undo', title: '撤销', run: undo },
  { icon: 'redo', title: '重做', run: redo },
]

const SELECTION_BUTTONS: { label: string; title: string; run: (v: EditorView) => unknown; cls?: string }[] = [
  { label: 'H', title: '标题', run: cycleHeading, cls: 'bold' },
  { label: 'B', title: '粗体', run: toggleBold, cls: 'bold' },
  { label: 'I', title: '斜体', run: toggleItalic, cls: 'italic' },
  { label: 'S', title: '删除线', run: toggleStrike, cls: 'strike' },
  { label: 'M', title: '高亮', run: toggleInline('==') },
  { label: '`', title: '行内代码', run: toggleCode, cls: 'mono' },
  { label: '↗', title: '链接', run: insertLink },
]

function run(fn: (v: EditorView) => unknown) {
  const v = editorView()
  if (v) fn(v)
}

// 焦点从编辑器移到别处时，focusout 先于新元素获得焦点，等一帧再判断
function sync() {
  requestAnimationFrame(async () => {
    const v = editorView()
    visible.value = !!ws.active && activeTab()?.status === 'ready' && (!coarse.matches || !!v?.hasFocus)
    floating.value = null
    if (!v || coarse.matches || !settings.selectionToolbar || !v.hasFocus || v.state.selection.main.empty || ws.settings || ws.images !== null) return
    const selection = v.state.selection.main
    const coords = v.coordsAtPos(selection.head)
    const rect = v.scrollDOM.getBoundingClientRect()
    if (!coords || coords.bottom < rect.top || coords.top > rect.bottom) return
    floating.value = { left: 0, top: 0 }
    await nextTick()
    const toolbar = floatingToolbar.value
    if (!toolbar || !floating.value) return
    const { width, height } = toolbar.getBoundingClientRect()
    floating.value = {
      left: Math.max(12, Math.min(innerWidth - width - 12, coords.left - width / 2)),
      top: Math.max(8, Math.min(innerHeight - height - 8, coords.top - height - 8 > rect.top ? coords.top - height - 8 : coords.bottom + 8)),
    }
  })
}

onMounted(() => {
  unsubscribe = onEditorUpdate(sync)
  document.addEventListener('scroll', sync, true)
  window.addEventListener('resize', sync)
  sync()
  document.addEventListener('focusin', sync)
  document.addEventListener('focusout', sync)
})
onBeforeUnmount(() => {
  unsubscribe?.()
  document.removeEventListener('scroll', sync, true)
  window.removeEventListener('resize', sync)
  document.removeEventListener('focusin', sync)
  document.removeEventListener('focusout', sync)
})
watch(() => [ws.active, activeTab()?.status, settings.selectionToolbar, settings.uiFontSize, ws.settings, ws.images], sync)
</script>

<template>
  <div v-if="visible" class="rm-format-bar" role="toolbar" aria-label="格式">
    <div class="rm-format-scroll">
      <button
        v-for="b in FORMAT_BUTTONS"
        :key="b.title"
        type="button"
        tabindex="-1"
        :aria-label="b.title"
        @mousedown.prevent
        @click="run(b.run)"
      >
        <Icon :name="b.icon" class="rm-format-icon" />
        <span class="rm-format-label" aria-hidden="true">{{ b.title }}</span>
      </button>
    </div>
  </div>
  <div ref="floatingToolbar" v-if="floating && ws.view === 'notes'" class="rm-selection-toolbar" role="toolbar" aria-label="选中文本格式" :style="{ left: floating.left + 'px', top: floating.top + 'px' }">
    <button v-for="b in SELECTION_BUTTONS" :key="b.title" :title="b.title" :aria-label="b.title" :class="b.cls" @mousedown.prevent @click="run(b.run)">{{ b.label }}</button>
  </div>
</template>
