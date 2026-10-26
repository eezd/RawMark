<script setup lang="ts">
import type { InputInstance } from 'element-plus'

import Icon from '@@/components/Icon/index.vue'
import { locale, t as translate } from '@@/i18n/runtime'
import { basename, dirname, inAssetDir, joinPath, noteTitle } from '@@/utils/paths'
import { isCancel } from 'axios'
import { computed, ref, watch } from 'vue'
import { batchFiles } from '../batch'
import { fuzzyMatch, segments } from '../fuzzy'
import { minimalPaths } from '../selection'
import { move, ws } from '../workspace'

// 「移动到…」：选择目标文件夹（手机上没有拖放，电脑上也比拖放快）
const props = defineProps<{ path: string | string[] }>()
const emit = defineEmits<{ close: [] }>()

const input = ref<InputInstance>()
const list = ref<HTMLElement>()
const query = ref('')
const selected = ref(0)
const busy = ref(false)
const error = ref('')
const paths = computed(() => minimalPaths(typeof props.path === 'string' ? [props.path] : props.path))
const title = computed(() => paths.value.length > 1 ? translate('workspace.items_980fda', { count: paths.value.length }) : noteTitle(paths.value[0]))

const targets = computed(() => {
  const inside = (dir: string) => paths.value.some(path => ws.entries.some(entry => entry.path === path && entry.dir) && (dir === path || dir.startsWith(`${path}/`)))
  return ['', ...ws.entries.filter(entry => entry.dir && !inAssetDir(entry.path)).map(entry => entry.path)]
    .filter(dir => !inside(dir) && !paths.value.every(path => dirname(path) === dir))
})

const items = computed(() => {
  const q = query.value.trim()
  if (!q) return [...targets.value].sort((a, b) => a.localeCompare(b, locale.value)).map(path => ({ path, hits: new Set<number>() }))
  return targets.value
    .filter(p => p !== '')
    .map(path => ({ path, m: fuzzyMatch(q, path, path.lastIndexOf('/') + 1) }))
    .filter(x => x.m)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map(x => ({ path: x.path, hits: new Set(x.m!.positions) }))
})

watch(query, () => (selected.value = 0))
watch(selected, i => list.value?.children[i]?.scrollIntoView({ block: 'nearest' }))

async function choose(i: number) {
  const target = items.value[i]
  if (!target || busy.value) return
  busy.value = true; error.value = ''
  try {
    if (paths.value.length === 1) {
      const result = await move(paths.value[0], joinPath(target.path, basename(paths.value[0])), 'caller')
      if (!result.ok) {
        error.value = result.error; return
      }
    } else if (!await batchFiles('move', paths.value, target.path)) {
      error.value = translate('workspace.some_items_could_not_be_8f48b2'); return
    }
    emit('close')
  } catch (cause) {
    if (!isCancel(cause)) error.value = String(cause)
  } finally {
    busy.value = false
  }
}
function close() {
  if (!busy.value) emit('close')
}
function opened() {
  if (!matchMedia('(pointer: coarse)').matches) input.value?.focus()
}
function onKeydown(e: KeyboardEvent) {
  const n = items.value.length
  if (e.key === 'Escape') close()
  else if (e.key === 'ArrowDown' && n) selected.value = (selected.value + 1) % n
  else if (e.key === 'ArrowUp' && n) selected.value = (selected.value - 1 + n) % n
  else if (e.key === 'Enter' && !e.isComposing && n) choose(selected.value)
  else return
  e.preventDefault()
}
</script>

<template>
  <el-dialog :model-value="true" :title="translate('workspace.move_e3e7e7', { p0: title })" width="560px" class="rm-picker-dialog" :show-close="!busy" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :before-close="close" @close="close" @opened="opened">
    <el-input ref="input" v-model="query" :disabled="busy" :placeholder="translate('workspace.move_to_d652dc', { p0: title })" :aria-label="translate('workspace.search_destination_folders_95ab69')" enterkeyhint="go" @keydown="onKeydown($event as KeyboardEvent)">
      <template #prefix>
        <Icon name="folder" />
      </template>
    </el-input>
    <p v-if="error" role="alert" class="rm-auth-error">
      {{ error }}
    </p>
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
          <template v-if="item.path === ''">{{ translate('workspace.root_folder_42ee28') }}</template>
          <span v-for="(s, j) in segments(item.path, item.hits)" v-else :key="j" :class="{ 'rm-search-hit': s.hit }">{{ s.text }}</span>
        </span>
      </li>
    </ul>
    <p v-else class="rm-tree-empty">
      {{ translate('workspace.no_available_destination_folders_d4d0c2') }}
    </p>
  </el-dialog>
</template>
