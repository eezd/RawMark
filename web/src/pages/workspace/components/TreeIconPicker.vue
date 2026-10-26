<script setup lang="ts">
import type { TreeIcon } from '@@/apis/tree/type'
import type { IconName } from '@@/utils/icons'
import type { Gemoji } from 'gemoji'
import Icon from '@@/components/Icon/index.vue'
import { iconPaths } from '@@/utils/icons'
import { basename } from '@@/utils/paths'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { treeIconTarget } from '../tree'
import { emojiCategories, emojiLabel, iconLabels, matchesEmoji } from '../tree-icon-catalog'
import { saveTreeIcon } from '../workspace'

const props = defineProps<{ target: { path: string, anchor: HTMLElement } }>()
const panel = ref<HTMLElement>()
const search = ref<HTMLInputElement>()
const position = ref({ left: 8, top: 8 })
const tab = ref<'emoji' | 'builtin'>('emoji')
const category = ref('Objects')
const query = ref('')
const emojis = ref<Gemoji[]>([])
const loading = ref(true)
const loadError = ref('')
const error = ref('')
const busy = ref(false)
const recent = ref<TreeIcon[]>([])
let resizeObserver: ResizeObserver | undefined
const RECENT_KEY = 'rawmark.recent-tree-icons'
const iconNames = Object.keys(iconPaths) as IconName[]
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return emojis.value.filter(e => q ? matchesEmoji(e, q) : e.category === category.value)
})
const linear = computed(() => {
  const q = query.value.trim().toLowerCase()
  return iconNames.filter(name => (`${name} ${iconLabels[name]}`).toLowerCase().includes(q))
})
const visibleRecent = computed(() => recent.value.filter(icon => icon.kind === tab.value))
const chosen = (icon: TreeIcon) => `${icon.kind}:${icon.value}`

function close() {
  if (busy.value) return
  treeIconTarget.value = null
  props.target.anchor.focus({ preventScroll: true })
}

function place() {
  if (!panel.value) return
  const anchor = props.target.anchor.getBoundingClientRect()
  const { width, height } = panel.value.getBoundingClientRect()
  position.value = {
    left: Math.max(8, Math.min(anchor.left, innerWidth - width - 8)),
    top: Math.max(8, Math.min(anchor.bottom + 4, innerHeight - height - 8)),
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); close()
  }
  if (event.key !== 'Tab' || !panel.value) return
  const buttons = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')]
  const index = buttons.indexOf(document.activeElement as HTMLElement)
  if (event.shiftKey && index <= 0) {
    event.preventDefault(); buttons.at(-1)?.focus()
  } else if (!event.shiftKey && index === buttons.length - 1) {
    event.preventDefault(); buttons[0]?.focus()
  }
}

async function loadEmojis() {
  loading.value = true
  loadError.value = ''
  try {
    emojis.value = (await import('gemoji')).gemoji
  } catch (err) {
    loadError.value = `表情加载失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    loading.value = false
  }
}

async function save(icon: TreeIcon | null) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await saveTreeIcon(props.target.path, icon)
    if (icon) {
      recent.value = [icon, ...recent.value.filter(item => chosen(item) !== chosen(icon))].slice(0, 24)
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value))
      } catch (err) {
        console.warn('保存最近图标失败', err)
      }
    }
    busy.value = false
    close()
  } catch (err) {
    error.value = `图标保存失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    if (Array.isArray(data)) recent.value = data.filter((item): item is TreeIcon => item && typeof item === 'object' && typeof item.value === 'string' && (item.kind === 'emoji' || (item.kind === 'builtin' && iconNames.includes(item.value)))).slice(0, 24)
  } catch (err) {
    console.warn('读取最近图标失败', err)
  }
  place()
  search.value?.focus({ preventScroll: true })
  resizeObserver = new ResizeObserver(place)
  resizeObserver.observe(panel.value!)
  window.addEventListener('resize', place)
  document.addEventListener('keydown', onKeydown, true)
  void loadEmojis()
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', place)
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div class="rm-menu-backdrop rm-tree-icon-backdrop" @click="close" @contextmenu.prevent="close" />
    <section ref="panel" class="rm-tree-icon-picker" role="dialog" aria-modal="true" aria-label="修改图标" :aria-busy="busy" :style="{ left: `${position.left}px`, top: `${position.top}px` }">
      <header>
        <span class="rm-tree-icon-title" :title="target.path">{{ basename(target.path) }}</span><button class="rm-icon-btn" title="关闭图标选择" aria-label="关闭图标选择" :disabled="busy" @click="close">
          <Icon name="close" />
        </button>
      </header>
      <div class="rm-tree-icon-tabs" role="tablist" aria-label="图标类型">
        <button role="tab" :aria-selected="tab === 'emoji'" :disabled="busy" @click="tab = 'emoji'">
          表情
        </button>
        <button role="tab" :aria-selected="tab === 'builtin'" :disabled="busy" @click="tab = 'builtin'">
          线性图标
        </button>
      </div>
      <input ref="search" v-model="query" class="rm-input" placeholder="搜索图标（中文 / English）" aria-label="搜索图标" :disabled="busy">
      <nav v-if="tab === 'emoji'" class="rm-tree-icon-categories" aria-label="表情分类">
        <button v-for="item in emojiCategories" :key="item.id" class="rm-emoji" :title="item.label" :aria-label="item.label" :aria-pressed="category === item.id && !query" :disabled="busy" @click="category = item.id; query = ''">
          {{ item.icon }}
        </button>
      </nav>
      <div class="rm-tree-icon-results">
        <template v-if="!query && visibleRecent.length">
          <p>最近使用</p>
          <div class="rm-tree-icon-grid">
            <button v-for="icon in visibleRecent" :key="chosen(icon)" :class="{ 'rm-emoji': icon.kind === 'emoji' }" :title="icon.kind === 'builtin' ? iconLabels[icon.value] : icon.value" :aria-label="`最近：${icon.kind === 'builtin' ? iconLabels[icon.value] : icon.value}`" :disabled="busy" @click="save(icon)">
              <Icon v-if="icon.kind === 'builtin'" :name="icon.value" :size="20" /><template v-else>
                {{ icon.value }}
              </template>
            </button>
          </div>
        </template>
        <template v-if="tab === 'emoji'">
          <p v-if="loading">
            正在加载表情…
          </p>
          <div v-else-if="loadError" role="alert">
            {{ loadError }} <el-button class="rm-btn" @click="loadEmojis">
              重试
            </el-button>
          </div>
          <template v-else>
            <p>{{ query ? '搜索结果' : emojiCategories.find(c => c.id === category)?.label }}</p>
            <div class="rm-tree-icon-grid">
              <button v-for="emoji in filtered" :key="emoji.emoji" class="rm-emoji" :title="emojiLabel(emoji)" :aria-label="emojiLabel(emoji)" :disabled="busy" @click="save({ kind: 'emoji', value: emoji.emoji })">
                {{ emoji.emoji }}
              </button>
            </div>
            <p v-if="!filtered.length">
              没有找到图标，试试其他关键词
            </p>
          </template>
        </template>
        <template v-else>
          <p>线性图标</p>
          <div class="rm-tree-icon-grid">
            <button v-for="name in linear" :key="name" :title="iconLabels[name]" :aria-label="iconLabels[name]" :disabled="busy" @click="save({ kind: 'builtin', value: name })">
              <Icon :name="name" :size="20" />
            </button>
          </div>
          <p v-if="!linear.length">
            没有找到图标，试试其他关键词
          </p>
        </template>
      </div>
      <p v-if="error" class="rm-tree-icon-error" role="alert">
        {{ error }}
      </p>
      <footer>
        <el-button class="rm-btn" :disabled="busy" @click="save(null)">
          {{ busy ? '正在保存…' : '恢复默认图标' }}
        </el-button>
      </footer>
    </section>
  </Teleport>
</template>

<style scoped>
.rm-tree-icon-backdrop {
  z-index: 46;
}
.rm-tree-icon-picker {
  position: fixed;
  z-index: 47;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--rm-space-2);
  width: 360px;
  max-width: calc(100vw - 16px);
  max-height: calc(100dvh - 16px);
  padding: var(--rm-space-3);
  border: 1px solid var(--rm-divider);
  border-radius: 14px;
  background: color-mix(in srgb, var(--rm-bg) 96%, transparent);
  backdrop-filter: blur(24px);
  box-shadow: var(--rm-shadow);
  font-size: var(--rm-ui-font-size);
}
header {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--rm-space-2);
}
.rm-tree-icon-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rm-tree-icon-tabs {
  display: flex;
  border-bottom: 1px solid var(--rm-divider);
}
.rm-tree-icon-tabs button {
  flex: 1;
  min-height: var(--rm-control-size);
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--rm-text-muted);
  cursor: pointer;
}
.rm-tree-icon-tabs [aria-selected='true'] {
  color: var(--rm-text);
  border-bottom-color: var(--rm-accent);
}
.rm-tree-icon-categories {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.rm-tree-icon-categories button {
  flex: 1;
  min-width: 28px;
  min-height: var(--rm-control-size);
  border: 0;
  border-radius: 4px;
  background: none;
  font-size: 18px;
  cursor: pointer;
}
.rm-tree-icon-results {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 300px;
  overflow: auto;
  overscroll-behavior: contain;
}
.rm-tree-icon-results p {
  margin: var(--rm-space-2) 0;
  color: var(--rm-text-muted);
  font-size: var(--rm-ui-font-small);
}
.rm-tree-icon-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(32px, 1fr));
  gap: 3px;
}
.rm-tree-icon-grid button {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--rm-text);
  font-size: 22px;
  cursor: pointer;
}
.rm-tree-icon-grid button:hover,
.rm-tree-icon-categories button:hover,
.rm-tree-icon-categories [aria-pressed='true'] {
  background: var(--rm-hover);
}
.rm-tree-icon-error {
  margin: 0;
  max-height: 80px;
  overflow: auto;
  color: var(--rm-danger);
  overflow-wrap: anywhere;
}
footer {
  flex: none;
  display: flex;
  justify-content: flex-end;
}
@media (pointer: coarse) {
  .rm-tree-icon-grid {
    grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  }
  .rm-tree-icon-grid button,
  .rm-tree-icon-categories button,
  .rm-tree-icon-tabs button {
    min-height: 44px;
  }
}
</style>
