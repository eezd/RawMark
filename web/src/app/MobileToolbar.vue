<script setup lang="ts">
import { indentLess, indentMore, redo, undo } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { cycleHeading, insertLink, toggleBlock, toggleBold, toggleCode, toggleItalic, toggleStrike } from '../editor/format'
import Icon from './Icon.vue'
import { editorView, insertImagesFromPicker } from './workspace'

// 手机键盘上方的 Markdown 工具条：只在触屏设备上、编辑器获得焦点（软键盘弹出）时显示。
// 按钮在 mousedown 时阻止默认行为，焦点留在编辑器中，键盘不会收起
// （不能在 pointerdown 上阻止：WebKit 会因此不再触发 click）
const visible = ref(false)
const coarse = matchMedia('(pointer: coarse)')

const BUTTONS: { label: string; title: string; run: (v: EditorView) => unknown; cls?: string }[] = [
  { label: 'H', title: '标题', run: cycleHeading, cls: 'bold' },
  { label: 'B', title: '粗体', run: toggleBold, cls: 'bold' },
  { label: 'I', title: '斜体', run: toggleItalic, cls: 'italic' },
  { label: 'S', title: '删除线', run: toggleStrike, cls: 'strike' },
  { label: '•', title: '无序列表', run: toggleBlock('bullet') },
  { label: '1.', title: '有序列表', run: toggleBlock('ordered') },
  { label: '☐', title: '任务列表', run: toggleBlock('task') },
  { label: '❝', title: '引用', run: toggleBlock('quote') },
  { label: '`', title: '行内代码', run: toggleCode, cls: 'mono' },
  { label: '🔗', title: '链接', run: insertLink },
  { label: '🖼', title: '插入图片', run: () => insertImagesFromPicker() },
  { label: '⇥', title: '缩进', run: indentMore },
  { label: '⇤', title: '取消缩进', run: indentLess },
  { label: '↶', title: '撤销', run: undo },
  { label: '↷', title: '重做', run: redo },
]

function run(fn: (v: EditorView) => unknown) {
  const v = editorView()
  if (v) fn(v)
}

function hideKeyboard() {
  editorView()?.contentDOM.blur()
}

// 焦点从编辑器移到别处时，focusout 先于新元素获得焦点，等一帧再判断
function sync() {
  requestAnimationFrame(() => (visible.value = coarse.matches && !!editorView()?.hasFocus))
}

onMounted(() => {
  document.addEventListener('focusin', sync)
  document.addEventListener('focusout', sync)
})
onBeforeUnmount(() => {
  document.removeEventListener('focusin', sync)
  document.removeEventListener('focusout', sync)
})
</script>

<template>
  <div v-if="visible" class="rm-format-bar" role="toolbar" aria-label="格式">
    <div class="rm-format-scroll">
      <button
        v-for="b in BUTTONS"
        :key="b.title"
        type="button"
        tabindex="-1"
        :class="b.cls"
        :title="b.title"
        :aria-label="b.title"
        @mousedown.prevent
        @click="run(b.run)"
      >
        {{ b.label }}
      </button>
    </div>
    <button type="button" tabindex="-1" class="rm-format-hide" title="收起键盘" aria-label="收起键盘" @mousedown.prevent @click="hideKeyboard">
      <Icon name="chevron" class="down" />
    </button>
  </div>
</template>
