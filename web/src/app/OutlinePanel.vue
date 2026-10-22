<script setup lang="ts">
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import NoteRelations from './NoteRelations.vue'
import { activeTab, editorView, onEditorUpdate, ws } from './workspace'

// 大纲：当前笔记的标题列表，点击跳转；高亮光标所在的章节
interface Heading {
  level: number
  text: string
  from: number
}

const headings = ref<Heading[]>([])
const current = ref(-1)

function collect(state: EditorState): Heading[] {
  // 长文档的语法树可能尚未解析完，最多等 50ms，之后随编辑更新
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)
  const out: Heading[] = []
  tree.iterate({
    enter(n) {
      const m = /^(ATX|Setext)Heading(\d)$/.exec(n.name)
      if (!m) return
      const line = state.doc.lineAt(n.from)
      const text = m[1] === 'ATX' ? line.text.replace(/^\s*#{1,6}\s*/, '').replace(/\s+#+\s*$/, '') : line.text.trim()
      out.push({ level: Number(m[2]), text: text || '（无标题）', from: n.from })
      return false
    },
  })
  return out
}

let timer: ReturnType<typeof setTimeout> | undefined
let lastDoc: unknown
function refresh() {
  const v = editorView()
  if (!v || activeTab()?.status !== 'ready') {
    headings.value = []
    lastDoc = undefined
    return
  }
  // 只移动光标时不重新收集标题
  if (v.state.doc !== lastDoc) {
    headings.value = collect(v.state)
    lastDoc = v.state.doc
  }
  const head = v.state.selection.main.head
  let i = headings.value.length - 1
  while (i >= 0 && headings.value[i].from > head) i--
  current.value = i
}
function scheduleRefresh() {
  clearTimeout(timer)
  timer = setTimeout(refresh, 150)
}

function jump(h: Heading) {
  const v = editorView()
  if (!v) return
  v.dispatch({ selection: { anchor: h.from }, effects: EditorView.scrollIntoView(h.from, { y: 'start', yMargin: 16 }) })
  if (matchMedia('(max-width: 768px)').matches) ws.outlineOpen = false
  else v.focus()
}

let unsubscribe: (() => void) | undefined
onMounted(() => {
  unsubscribe = onEditorUpdate(scheduleRefresh)
  // 切换标签页时编辑器整体替换状态，不经过更新监听；等编辑器面板换好状态后再读
  requestAnimationFrame(refresh)
})
onBeforeUnmount(() => {
  unsubscribe?.()
  clearTimeout(timer)
})
watch(
  () => [ws.active, activeTab()?.status],
  () => requestAnimationFrame(refresh),
)
const minLevel = () => Math.min(...headings.value.map((h) => h.level))
</script>

<template>
  <div class="rm-outline-backdrop" @click.self="ws.outlineOpen = false">
    <aside class="rm-outline" aria-label="大纲">
      <div class="rm-outline-head">
        <span>大纲</span>
        <button class="rm-icon-btn" title="关闭大纲" @click="ws.outlineOpen = false"><Icon name="close" /></button>
      </div>
      <ul v-if="headings.length" class="rm-outline-list">
        <li
          v-for="(h, i) in headings"
          :key="h.from"
          :class="{ on: i === current }"
          :style="{ paddingLeft: (h.level - minLevel()) * 14 + 12 + 'px' }"
          @mousedown.prevent
          @click="jump(h)"
        >
          {{ h.text }}
        </li>
      </ul>
      <p v-else class="rm-tree-empty">没有标题</p>
      <NoteRelations />
    </aside>
  </div>
</template>
