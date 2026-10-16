<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { fuzzyMatch } from './fuzzy'
import Icon from './Icon.vue'
import { dirname, NOTE_EXT, noteTitle } from './paths'
import { createNoteAt, openAt, ws } from './workspace'

const MAX_ITEMS = 50

interface Item {
  path: string
  title: string
  dir: string
  // 命中字符在标题、目录中的下标
  titleHits: Set<number>
  dirHits: Set<number>
}

const input = ref<HTMLInputElement>()
const list = ref<HTMLElement>()
const query = ref('')
const selected = ref(0)

// 取消时把焦点还给打开前的元素（通常是编辑器）
const previousFocus = document.activeElement as HTMLElement | null
function close() {
  ws.switcherOpen = false
}
function cancel() {
  close()
  previousFocus?.focus()
}

/** 按命中与否把文本切成连续片段 */
function segments(text: string, hits: Set<number>) {
  const out: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i)
    const last = out[out.length - 1]
    if (last?.hit === hit) last.text += text[i]
    else out.push({ text: text[i], hit })
  }
  return out
}

const items = computed<Item[]>(() => {
  const q = query.value.trim()
  const recentRank = new Map(ws.recent.map((p, i) => [p, i]))
  const notes = ws.entries.filter((e) => !e.dir)
  const toItem = (path: string, positions: number[] = []): Item => {
    const dir = dirname(path)
    const offset = dir ? dir.length + 1 : 0
    return {
      path,
      title: noteTitle(path),
      dir,
      titleHits: new Set(positions.filter((p) => p >= offset).map((p) => p - offset)),
      dirHits: new Set(positions.filter((p) => p < offset)),
    }
  }
  if (!q) {
    // 最近打开的在前（当前笔记除外，回车即回到上一篇），其余按修改时间
    const rank = (p: string) => recentRank.get(p) ?? Infinity
    const mtime = new Map(notes.map((e) => [e.path, e.mtime]))
    return notes
      .map((e) => e.path)
      .filter((p) => p !== ws.active)
      .sort((a, b) => rank(a) - rank(b) || mtime.get(b)! - mtime.get(a)!)
      .slice(0, MAX_ITEMS)
      .map((p) => toItem(p))
  }
  const scored: { path: string; score: number; positions: number[] }[] = []
  for (const e of notes) {
    const target = e.path.slice(0, -NOTE_EXT.length)
    const m = fuzzyMatch(q, target, target.lastIndexOf('/') + 1)
    if (m) scored.push({ path: e.path, ...m })
  }
  scored.sort(
    (a, b) => b.score - a.score || (recentRank.get(a.path) ?? Infinity) - (recentRank.get(b.path) ?? Infinity) || a.path.length - b.path.length,
  )
  return scored.slice(0, MAX_ITEMS).map((s) => toItem(s.path, s.positions))
})

// 没有同名笔记时提供"新建"；输入中的 / 表示目录
const createPath = computed(() => {
  const q = query.value.trim().replace(/\.md$/i, '')
  if (!q || !q.split('/').every((seg) => seg.trim() && !seg.startsWith('.'))) return null
  const path = q + NOTE_EXT
  return ws.entries.some((e) => e.path.toLowerCase() === path.toLowerCase()) ? null : path
})
const count = computed(() => items.value.length + (createPath.value ? 1 : 0))

watch(query, () => (selected.value = 0))
watch(selected, (i) => list.value?.children[i]?.scrollIntoView({ block: 'nearest' }))

function choose(i: number) {
  const item = items.value[i]
  const create = createPath.value
  close()
  if (item) void openAt(item.path)
  else if (create) {
    void createNoteAt(create).then((ok) => {
      if (ok) void openAt(create)
    })
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') cancel()
  else if (e.key === 'ArrowDown' && count.value) selected.value = (selected.value + 1) % count.value
  else if (e.key === 'ArrowUp' && count.value) selected.value = (selected.value - 1 + count.value) % count.value
  else if (e.key === 'Enter' && !e.isComposing && count.value) choose(selected.value)
  else return
  e.preventDefault()
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div class="rm-switcher-backdrop" @mousedown.self="cancel">
    <div class="rm-switcher" role="dialog" aria-label="快速打开">
      <div class="rm-search-box">
        <Icon name="search" />
        <input
          ref="input"
          v-model="query"
          class="rm-search-input"
          placeholder="输入笔记名称，回车打开或新建"
          enterkeyhint="go"
          @keydown="onKeydown"
          @blur="close"
        />
      </div>
      <ul v-if="count" ref="list" class="rm-switcher-list" @mousedown.prevent>
        <li
          v-for="(item, i) in items"
          :key="item.path"
          class="rm-switcher-item"
          :class="{ active: i === selected }"
          @click="choose(i)"
          @mousemove="selected = i"
        >
          <Icon name="note" />
          <span class="rm-switcher-title">
            <span v-for="(s, j) in segments(item.title, item.titleHits)" :key="j" :class="{ 'rm-search-hit': s.hit }">{{ s.text }}</span>
          </span>
          <span v-if="item.dir" class="rm-switcher-dir">
            <span v-for="(s, j) in segments(item.dir, item.dirHits)" :key="j" :class="{ 'rm-search-hit': s.hit }">{{ s.text }}</span>
          </span>
        </li>
        <li
          v-if="createPath"
          class="rm-switcher-item"
          :class="{ active: selected === items.length }"
          @click="choose(items.length)"
          @mousemove="selected = items.length"
        >
          <Icon name="noteAdd" />
          <span class="rm-switcher-title">新建笔记“{{ createPath.slice(0, -NOTE_EXT.length) }}”</span>
        </li>
      </ul>
      <p v-else class="rm-tree-empty">还没有笔记</p>
    </div>
  </div>
</template>
