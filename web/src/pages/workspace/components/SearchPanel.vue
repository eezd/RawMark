<script setup lang="ts">
import type { SearchResult } from '@@/apis/search/type'

import { searchApi } from '@@/apis/search'

import Icon from '@@/components/Icon/index.vue'
import { t as translate } from '@@/i18n/runtime'
import { reportError } from '@@/utils/notifications'

import { dirname, noteTitle } from '@@/utils/paths'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useUserStore } from '@/pinia/stores/user'
import { openAt, ws } from '../workspace'

const SEARCH_DELAY = 150
const user = useUserStore()

const input = ref<HTMLInputElement>()
const query = ref('')
const results = ref<SearchResult[] | null>(null)
const selected = ref(0)
const terms = computed(() => query.value.split(/\s+/).filter(Boolean))

// Use only the latest request's results so slow requests cannot overwrite newer results.
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined
watch(query, (q) => {
  const id = ++seq
  const version = user.getSessionVersion()
  clearTimeout(timer)
  results.value = null
  timer = setTimeout(() => void run(q, id, version), SEARCH_DELAY)
}, { flush: 'sync' })
onBeforeUnmount(() => {
  clearTimeout(timer)
  seq++
})

async function run(q: string, id: number, version: number) {
  if (!q.trim()) return
  try {
    user.assertSession(version)
    const r = (await searchApi({ q })).data.results
    user.assertSession(version)
    if (id !== seq) return
    results.value = r
    selected.value = 0
  } catch (cause) {
    if (id === seq) reportError(cause)
  }
}

/** Split text by case-insensitive search terms and mark matching fragments for highlighting. */
function segments(text: string): { text: string, hit: boolean }[] {
  const lower = text.toLowerCase()
  const words = terms.value.map(t => t.toLowerCase())
  const out: { text: string, hit: boolean }[] = []
  let plain = ''
  for (let i = 0; i < text.length;) {
    const len = Math.max(0, ...words.filter(w => lower.startsWith(w, i)).map(w => w.length))
    if (len) {
      if (plain) out.push({ text: plain, hit: false })
      out.push({ text: text.slice(i, i + len), hit: true })
      plain = ''
      i += len
    } else {
      plain += text[i++]
    }
  }
  if (plain) out.push({ text: plain, hit: false })
  return out
}

function open(r: SearchResult) {
  void openAt(r.path, r.line, terms.value)
}

function onKeydown(e: KeyboardEvent) {
  const list = results.value ?? []
  if (e.key === 'Escape') ws.searchOpen = false
  else if (e.key === 'ArrowDown' && list.length) selected.value = (selected.value + 1) % list.length
  else if (e.key === 'ArrowUp' && list.length) selected.value = (selected.value - 1 + list.length) % list.length
  else if (e.key === 'Enter' && list[selected.value]) open(list[selected.value])
  else return
  e.preventDefault()
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div class="rm-search">
    <div class="rm-search-box">
      <Icon name="search" />
      <input
        ref="input"
        v-model="query"
        class="rm-search-input"
        type="search"
        :placeholder="translate('workspace.search_notes_d8912a')"
        enterkeyhint="search"
        @keydown="onKeydown"
      >
      <button class="rm-icon-btn" :title="translate('workspace.close_search_ab008e')" @click="ws.searchOpen = false">
        <Icon name="close" />
      </button>
    </div>
    <ul v-if="results?.length" class="rm-search-results">
      <li
        v-for="(r, i) in results"
        :key="r.path"
        class="rm-search-item"
        :class="{ active: i === selected, current: r.path === ws.active }"
        @click="open(r)"
        @mousemove="selected = i"
      >
        <div class="rm-search-title">
          <span v-for="(s, j) in segments(noteTitle(r.path))" :key="j" :class="{ 'rm-search-hit': s.hit }">{{ s.text }}</span>
          <span v-if="dirname(r.path)" class="rm-search-dir">{{ dirname(r.path) }}</span>
        </div>
        <div v-if="r.snippet" class="rm-search-snippet">
          <span v-for="(s, j) in segments(r.snippet)" :key="j" :class="{ 'rm-search-hit': s.hit }">{{ s.text }}</span>
        </div>
      </li>
    </ul>
    <p v-else-if="results" class="rm-tree-empty">
      {{ translate('workspace.no_matching_notes_found_d87b01') }}
    </p>
    <p v-else class="rm-tree-empty">
      {{ translate('workspace.enter_keywords_separated_by_spaces_a25285') }}
    </p>
  </div>
</template>
