<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { fuzzyMatch, segments } from './fuzzy'
import Icon from './Icon.vue'
import { basename, dirname, inAssetDir, joinPath, noteTitle } from './paths'
import { move, ws } from './workspace'

// 「移动到…」：选择目标文件夹（手机上没有拖放，电脑上也比拖放快）
const props = defineProps<{ path: string }>()
const emit = defineEmits<{ close: [] }>()

const input = ref<HTMLInputElement>()
const list = ref<HTMLElement>()
const query = ref('')
const selected = ref(0)
const isDir = computed(() => ws.entries.some((e) => e.path === props.path && e.dir))
const title = computed(() => (isDir.value ? basename(props.path) : noteTitle(props.path)))

// 可选的目标：根目录与所有文件夹；排除当前所在的文件夹，移动文件夹时还要排除它自己及其子文件夹
const targets = computed(() => {
  const here = dirname(props.path)
  const inside = (d: string) => isDir.value && (d === props.path || d.startsWith(props.path + '/'))
  const dirs = ws.entries.filter((e) => e.dir && !inAssetDir(e.path) && e.path !== here && !inside(e.path)).map((e) => e.path)
  return here === '' ? dirs : ['', ...dirs]
})

const items = computed(() => {
  const q = query.value.trim()
  if (!q) return [...targets.value].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((path) => ({ path, hits: new Set<number>() }))
  return targets.value
    .filter((p) => p !== '')
    .map((path) => ({ path, m: fuzzyMatch(q, path, path.lastIndexOf('/') + 1) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map((x) => ({ path: x.path, hits: new Set(x.m!.positions) }))
})

watch(query, () => (selected.value = 0))
watch(selected, (i) => list.value?.children[i]?.scrollIntoView({ block: 'nearest' }))

function choose(i: number) {
  const target = items.value[i]
  if (!target) return
  emit('close')
  void move(props.path, joinPath(target.path, basename(props.path)))
}

function onKeydown(e: KeyboardEvent) {
  const n = items.value.length
  if (e.key === 'Escape') emit('close')
  else if (e.key === 'ArrowDown' && n) selected.value = (selected.value + 1) % n
  else if (e.key === 'ArrowUp' && n) selected.value = (selected.value - 1 + n) % n
  else if (e.key === 'Enter' && !e.isComposing && n) choose(selected.value)
  else return
  e.preventDefault()
}

onMounted(() => {
  // 触屏设备上不自动弹出键盘，文件夹不多时直接点选更方便
  if (!matchMedia('(pointer: coarse)').matches) input.value?.focus()
})
</script>

<template>
  <div class="rm-switcher-backdrop" @mousedown.self="emit('close')">
    <div class="rm-switcher" role="dialog" :aria-label="`移动“${title}”`">
      <div class="rm-search-box">
        <Icon name="folder" />
        <input ref="input" v-model="query" class="rm-search-input" :placeholder="`把“${title}”移动到…`" enterkeyhint="go" @keydown="onKeydown" />
        <button class="rm-icon-btn" title="取消" @click="emit('close')"><Icon name="close" /></button>
      </div>
      <ul v-if="items.length" ref="list" class="rm-switcher-list">
        <li
          v-for="(item, i) in items"
          :key="item.path"
          class="rm-switcher-item"
          :class="{ active: i === selected }"
          @click="choose(i)"
          @mousemove="selected = i"
        >
          <Icon name="folder" />
          <span class="rm-switcher-title">
            <template v-if="item.path === ''">根目录</template>
            <span v-for="(s, j) in segments(item.path, item.hits)" v-else :key="j" :class="{ 'rm-search-hit': s.hit }">{{ s.text }}</span>
          </span>
        </li>
      </ul>
      <p v-else class="rm-tree-empty">没有可移动到的文件夹</p>
    </div>
  </div>
</template>
