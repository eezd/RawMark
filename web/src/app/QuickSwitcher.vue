<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { availableCommands, formatKeys } from './commands'
import { fuzzyMatch, segments } from './fuzzy'
import Icon from './Icon.vue'
import { dirname, NOTE_EXT, noteTitle } from './paths'
import { createNoteAt, openAt, ws } from './workspace'

const MAX_ITEMS = 50
const RECENT_COMMANDS_KEY = 'rawmark.recentCommands'
const RECENT_COMMANDS_MAX = 10

interface Item {
  key: string
  icon: 'note' | 'noteAdd' | 'command'
  title: string
  // 笔记为所在目录，命令为快捷键
  detail: string
  // 命中字符在标题、目录中的下标
  titleHits: Set<number>
  detailHits: Set<number>
  run: () => void
}

const input = ref<HTMLInputElement>()
const list = ref<HTMLElement>()
const query = ref(ws.switcher ?? '')
const selected = ref(0)
// 以 > 开头时列出命令（与 VS Code 一致），删掉 > 回到找笔记
const commandMode = computed(() => query.value.startsWith('>'))

// 取消时把焦点还给打开前的元素（通常是编辑器）
const previousFocus = document.activeElement as HTMLElement | null
function close() {
  ws.switcher = null
}
function cancel() {
  close()
  previousFocus?.focus()
}

function noteItems(q: string): Item[] {
  const recentRank = new Map(ws.recent.map((p, i) => [p, i]))
  const notes = ws.entries.filter((e) => !e.dir && e.path.endsWith(NOTE_EXT))
  const toItem = (path: string, positions: number[] = []): Item => {
    const dir = dirname(path)
    const offset = dir ? dir.length + 1 : 0
    return {
      key: path,
      icon: 'note',
      title: noteTitle(path),
      detail: dir,
      titleHits: new Set(positions.filter((p) => p >= offset).map((p) => p - offset)),
      detailHits: new Set(positions.filter((p) => p < offset)),
      run: () => void openAt(path),
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
  const items = scored.slice(0, MAX_ITEMS).map((s) => toItem(s.path, s.positions))
  // 没有同名笔记时提供"新建"；输入中的 / 表示目录
  const name = q.replace(/\.md$/i, '')
  const path = name + NOTE_EXT
  if (
    name.split('/').every((seg) => seg.trim() && !seg.startsWith('.')) &&
    !ws.entries.some((e) => e.path.toLowerCase() === path.toLowerCase())
  ) {
    items.push({
      key: '\0create',
      icon: 'noteAdd',
      title: `新建笔记“${name}”`,
      detail: '',
      titleHits: new Set(),
      detailHits: new Set(),
      run: () =>
        void createNoteAt(path).then((ok) => {
          if (ok) void openAt(path)
        }),
    })
  }
  return items
}

const recentCommands = ref<string[]>(JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) ?? '[]'))

function commandItems(q: string): Item[] {
  const rank = (id: string) => {
    const i = recentCommands.value.indexOf(id)
    return i < 0 ? Infinity : i
  }
  const scored = availableCommands()
    .filter((c) => c.id !== 'app.commandPalette')
    .map((c, order) => ({ c, order, m: q ? fuzzyMatch(q, c.title, 0) : { score: 0, positions: [] } }))
    .filter((x) => x.m)
  // 无输入时最近用过的在前，其余保持注册顺序
  scored.sort((a, b) => b.m!.score - a.m!.score || rank(a.c.id) - rank(b.c.id) || a.order - b.order)
  return scored.map(({ c, m }) => ({
    key: c.id,
    icon: 'command',
    title: c.title,
    detail: c.keys ? formatKeys(c.keys[0]) : '',
    titleHits: new Set(m!.positions),
    detailHits: new Set(),
    run: () => {
      recentCommands.value = [c.id, ...recentCommands.value.filter((id) => id !== c.id)].slice(0, RECENT_COMMANDS_MAX)
      localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(recentCommands.value))
      c.run()
    },
  }))
}

const items = computed(() => (commandMode.value ? commandItems(query.value.slice(1).trim()) : noteItems(query.value.trim())))

watch(query, () => (selected.value = 0))
watch(selected, (i) => list.value?.children[i]?.scrollIntoView({ block: 'nearest' }))

function choose(i: number) {
  const item = items.value[i]
  close()
  item?.run()
}

function onKeydown(e: KeyboardEvent) {
  const n = items.value.length
  if (e.key === 'Escape') cancel()
  else if (e.key === 'ArrowDown' && n) selected.value = (selected.value + 1) % n
  else if (e.key === 'ArrowUp' && n) selected.value = (selected.value - 1 + n) % n
  else if (e.key === 'Enter' && !e.isComposing && n) choose(selected.value)
  else return
  e.preventDefault()
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div class="rm-switcher-backdrop" @mousedown.self="cancel">
    <div class="rm-switcher" role="dialog" :aria-label="commandMode ? '命令面板' : '快速打开'">
      <div class="rm-search-box">
        <Icon :name="commandMode ? 'command' : 'search'" />
        <input
          ref="input"
          v-model="query"
          class="rm-search-input"
          :placeholder="commandMode ? '输入命令名称' : '输入笔记名称，回车打开或新建；输入 > 执行命令'"
          enterkeyhint="go"
          @keydown="onKeydown"
          @blur="close"
        />
      </div>
      <ul v-if="items.length" ref="list" class="rm-switcher-list" @mousedown.prevent>
        <li
          v-for="(item, i) in items"
          :key="item.key"
          class="rm-switcher-item"
          :class="{ active: i === selected }"
          @click="choose(i)"
          @mousemove="selected = i"
        >
          <Icon :name="item.icon" />
          <span class="rm-switcher-title">
            <span v-for="(s, j) in segments(item.title, item.titleHits)" :key="j" :class="{ 'rm-search-hit': s.hit }">{{ s.text }}</span>
          </span>
          <span v-if="item.detail" class="rm-switcher-dir" :class="{ 'rm-switcher-keys': item.icon === 'command' }">
            <span v-for="(s, j) in segments(item.detail, item.detailHits)" :key="j" :class="{ 'rm-search-hit': s.hit }">{{ s.text }}</span>
          </span>
        </li>
      </ul>
      <p v-else class="rm-tree-empty">{{ commandMode ? '没有匹配的命令' : '还没有笔记' }}</p>
    </div>
  </div>
</template>
