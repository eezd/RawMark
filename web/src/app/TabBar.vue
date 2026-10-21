<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { commandTitle } from './commands'
import Icon from './Icon.vue'
import { noteTitle } from './paths'
import { closeTab, ws } from './workspace'

// 拖动排序：拖到某个标签的左半边插到它前面，右半边插到它后面
const TAB_TYPE = 'application/x-rawmark-tab'
const dragging = ref<string | null>(null)
const dropAt = ref<{ path: string; after: boolean } | null>(null)

function onDragStart(e: DragEvent, path: string) {
  dragging.value = path
  e.dataTransfer!.setData(TAB_TYPE, path)
  e.dataTransfer!.effectAllowed = 'move'
}

function onDragOver(e: DragEvent, path: string) {
  if (!e.dataTransfer?.types.includes(TAB_TYPE)) return
  e.preventDefault()
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropAt.value = { path, after: e.clientX > r.left + r.width / 2 }
}

function onDrop(e: DragEvent) {
  const from = dragging.value
  const target = dropAt.value
  dragging.value = dropAt.value = null
  if (!from || !target || from === target.path) return
  e.preventDefault()
  const tab = ws.tabs.splice(
    ws.tabs.findIndex((t) => t.path === from),
    1,
  )[0]
  const i = ws.tabs.findIndex((t) => t.path === target.path) + (target.after ? 1 : 0)
  ws.tabs.splice(i, 0, tab)
}

function onDragEnd() {
  dragging.value = dropAt.value = null
}

// ---- 右键菜单 ----
const menu = ref<{ path: string; x: number; y: number } | null>(null)

const menuElement = ref<HTMLElement>()
async function openMenu(e: MouseEvent, path: string) {
  menu.value = { path, x: e.clientX, y: e.clientY }
  await nextTick()
  if (menu.value?.path !== path || !menuElement.value) return
  const { width, height } = menuElement.value.getBoundingClientRect()
  menu.value.x = Math.max(4, Math.min(e.clientX, innerWidth - width - 4))
  menu.value.y = Math.max(4, Math.min(e.clientY, innerHeight - height - 4))
}

async function closeMany(keep: (index: number, path: string) => boolean) {
  const paths = ws.tabs.filter((t, i) => !keep(i, t.path)).map((t) => t.path)
  menu.value = null
  for (const p of paths) await closeTab(p)
}

function closeOthers(path: string) {
  void closeMany((_, p) => p === path)
}

function closeRight(path: string) {
  const at = ws.tabs.findIndex((t) => t.path === path)
  void closeMany((i) => i <= at)
}
</script>

<template>
  <nav class="rm-tabs" :class="{ empty: !ws.tabs.length && !ws.sidebarCollapsed }" role="tablist">
    <button v-if="ws.sidebarCollapsed" class="rm-icon-btn rm-tabs-side" :title="commandTitle('view.sidebar')" @click="ws.sidebarCollapsed = false">
      <Icon name="menu" />
    </button>
    <div
      v-for="tab in ws.tabs"
      :key="tab.path"
      class="rm-tab"
      :class="{
        active: ws.active === tab.path,
        dragging: dragging === tab.path,
        'drop-before': dropAt?.path === tab.path && !dropAt.after,
        'drop-after': dropAt?.path === tab.path && dropAt.after,
      }"
      role="tab"
      :aria-selected="ws.active === tab.path"
      :title="tab.path"
      draggable="true"
      @click="ws.active = tab.path"
      @auxclick.prevent="$event.button === 1 && closeTab(tab.path)"
      @contextmenu.prevent="openMenu($event, tab.path)"
      @dragstart="onDragStart($event, tab.path)"
      @dragover="onDragOver($event, tab.path)"
      @drop="onDrop"
      @dragend="onDragEnd"
    >
      <span class="rm-tab-title">{{ noteTitle(tab.path) }}</span>
      <button class="rm-tab-close" :class="{ dirty: tab.dirty }" title="关闭" @click.stop="closeTab(tab.path)">
        <span class="rm-dirty-dot" />
        <Icon name="close" :size="12" />
      </button>
    </div>
    <button v-if="ws.active" class="rm-icon-btn rm-tabs-outline" :class="{ on: ws.outlineOpen }" :title="commandTitle('view.outline')" @click="ws.outlineOpen = !ws.outlineOpen">
      <Icon name="outline" />
    </button>
    <template v-if="menu">
      <div class="rm-menu-backdrop" @click="menu = null" @contextmenu.prevent="menu = null" />
      <div ref="menuElement" class="rm-menu rm-tab-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <button @click="closeMany((_, p) => p !== menu!.path)">关闭</button>
        <button @click="closeOthers(menu.path)">关闭其他标签页</button>
        <button @click="closeRight(menu.path)">关闭右侧标签页</button>
      </div>
    </template>
  </nav>
</template>
