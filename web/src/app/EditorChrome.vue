<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { basename } from './paths'
import { readingStats } from './reading'
import { activeTab, editorView, onEditorUpdate, toggleSourceMode, ws } from './workspace'

const stats = ref(readingStats(''))
const tab = computed(activeTab)
const parts = computed(() => ws.active?.split('/') ?? [])
const modified = computed(() => {
  const value = ws.entries.find(e => e.path === ws.active)?.mtime
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value) : ''
})
function refresh() { stats.value = readingStats(editorView()?.state.doc.toString() ?? '') }
let unsubscribe: (() => void) | undefined
onMounted(() => { unsubscribe = onEditorUpdate(refresh); requestAnimationFrame(refresh) })
onBeforeUnmount(() => unsubscribe?.())
watch(() => [ws.active, tab.value?.status], () => requestAnimationFrame(refresh))
</script>

<template>
  <section v-if="ws.active" class="rm-editor-chrome">
    <div class="rm-breadcrumb"><span>知识库</span><template v-for="(part, i) in parts" :key="i"><span class="rm-crumb-separator">/</span><span :class="{ current: i === parts.length - 1 }">{{ part }}</span></template></div>
    <div class="rm-document-meta"><span>字数统计 <strong>{{ stats.words.toLocaleString('zh-CN') }}</strong> 字</span><span>预计阅读 {{ stats.minutes }} 分钟</span><span v-if="modified">更新于 {{ modified }}</span><span :class="{ 'rm-share-bad': tab?.saveError }">{{ tab?.saveError ? '保存失败' : tab?.status === 'conflict' ? '存在冲突' : tab?.dirty ? '正在保存…' : '已保存' }}</span></div>
    <div class="rm-document-actions">
      <div class="rm-mode-switch"><button :class="{ on: !ws.sourceMode }" @mousedown.prevent @click="ws.sourceMode && toggleSourceMode()"><Icon name="eye" />即时预览</button><button :class="{ on: ws.sourceMode }" @mousedown.prevent @click="!ws.sourceMode && toggleSourceMode()"><Icon name="source" />源码模式</button></div>
      <button class="rm-icon-btn" :aria-pressed="ws.outlineOpen" title="显示 / 隐藏大纲" @click="ws.outlineOpen = !ws.outlineOpen"><Icon name="outline" /></button>
      <button class="rm-icon-btn" :aria-pressed="ws.focusMode" title="专注写作" @click="ws.focusMode = !ws.focusMode"><Icon name="expand" /></button>
      <button class="rm-btn" @click="ws.sharing = ws.active"><Icon name="share" />分享</button>
      <span class="rm-document-filename" :title="ws.active">{{ basename(ws.active) }}</span>
    </div>
  </section>
</template>
