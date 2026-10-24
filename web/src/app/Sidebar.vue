<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { basename } from './paths'
import { commandTitle } from './commands'
import { dropDirectory, tree } from './tree'
import TreeNode from './TreeNode.vue'
import SearchPanel from './SearchPanel.vue'
import { createFolder, createNote, move, openSearch, ws } from './workspace'
import { sidebarViews } from '../plugins/registry'
import PluginMount from './PluginMount.vue'

const emit = defineEmits<{ logout: [] }>()
const rootMenu = ref<{ x: number; y: number } | null>(null)
const menuElement = ref<HTMLElement>()
async function rootContext(event: MouseEvent) {
  if (event.target instanceof Element && event.target.closest('.rm-tree-row')) return
  event.preventDefault()
  const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect()
  rootMenu.value = event.type === 'click' ? { x: anchor.left, y: anchor.bottom } : { x: event.clientX, y: event.clientY }
  await nextTick()
  if (!rootMenu.value || !menuElement.value) return
  const { width, height } = menuElement.value.getBoundingClientRect()
  rootMenu.value.x = Math.max(4, Math.min(rootMenu.value.x, innerWidth - width - 4))
  rootMenu.value.y = Math.max(4, Math.min(rootMenu.value.y, innerHeight - height - 4))
}
watch(rootMenu, (menu, _previous, onCleanup) => {
  if (!menu) return
  const close = () => { rootMenu.value = null }
  const onKeydown = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
  window.addEventListener('resize', close)
  window.addEventListener('keydown', onKeydown)
  onCleanup(() => {
    window.removeEventListener('resize', close)
    window.removeEventListener('keydown', onKeydown)
  })
})

function runRootMenu(action: 'search' | 'tags' | 'note' | 'folder' | 'import' | 'images') {
  rootMenu.value = null
  if (action === 'search') openSearch()
  else if (action === 'tags') { ws.view = 'tags'; ws.images = null; ws.sidebarOpen = false }
  else if (action === 'note' || action === 'folder') {
    selectedView.value = ''
    ws.searchOpen = false
    void (action === 'note' ? createNote('') : createFolder(''))
  } else if (action === 'import') ws.importing = ''
  else { ws.imagesAll = false; ws.images = '' }
}
const selectedView = ref('')
const currentView = computed(() => sidebarViews.get(selectedView.value))
watch(() => ws.searchOpen, () => { selectedView.value = '' })

function onRootDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('application/x-rawmark-path')) return
  if (e.target instanceof Element && e.target.closest('.rm-tree-item')) {
    dropDirectory.value = null
    return
  }
  e.preventDefault()
  dropDirectory.value = ''
}

function onRootDrop(e: DragEvent) {
  dropDirectory.value = null
  if (!e.dataTransfer?.types.includes('application/x-rawmark-path')) return
  if (e.target instanceof Element && e.target.closest('.rm-tree-item')) return
  e.preventDefault()
  const src = e.dataTransfer?.getData('application/x-rawmark-path')
  if (!src || !src.includes('/')) return
  void move(src, basename(src))
}

function clearDrop() { dropDirectory.value = null }
function onTreeDragLeave(e: DragEvent) {
  if (e.currentTarget instanceof Element && e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
  clearDrop()
}
function onDragKeydown(e: KeyboardEvent) { if (e.key === 'Escape') clearDrop() }
onMounted(() => {
  window.addEventListener('dragend', clearDrop)
  window.addEventListener('drop', clearDrop)
  window.addEventListener('blur', clearDrop)
  window.addEventListener('keydown', onDragKeydown)
})
onUnmounted(() => {
  window.removeEventListener('dragend', clearDrop)
  window.removeEventListener('drop', clearDrop)
  window.removeEventListener('blur', clearDrop)
  window.removeEventListener('keydown', onDragKeydown)
  clearDrop()
})
</script>

<template>
  <div class="rm-sidebar-inner">
    <div class="rm-vault-heading">
      <button class="rm-icon-btn" title="折叠目录" aria-label="折叠目录" @click="ws.sidebarCollapsed = true; ws.sidebarOpen = false"><Icon name="menu" /></button>
    </div>
    <button class="rm-tree-label" title="文件目录操作" aria-haspopup="true" :aria-expanded="rootMenu !== null" @click="rootContext" @contextmenu="rootContext">文件目录</button>
    <nav v-if="sidebarViews.size" class="rm-plugin-tabs" aria-label="侧栏视图">
      <button class="rm-btn" :class="{ on: !currentView }" @click="selectedView = ''">文件</button>
      <button v-for="[id, pluginView] in sidebarViews" :key="id" class="rm-btn" :class="{ on: selectedView === id }" @click="selectedView = id">{{ pluginView.title }}</button>
    </nav>
    <PluginMount v-if="currentView" :key="selectedView" :view="currentView" />
    <SearchPanel v-else-if="ws.searchOpen" />
    <div v-else class="rm-tree" @contextmenu="rootContext" :class="{ drop: dropDirectory === '' }" @dragover="onRootDragOver" @dragleave="onTreeDragLeave" @drop="onRootDrop">
      <ul class="rm-tree-list">
        <TreeNode v-for="node in tree" :key="node.path" :node="node" :depth="0" />
      </ul>
      <p v-if="!tree.length" class="rm-tree-empty">还没有笔记</p>
    </div>
    <Teleport v-if="rootMenu" to="body">
      <div class="rm-menu-backdrop rm-context-menu-backdrop" @click="rootMenu = null" @contextmenu.prevent="rootMenu = null" />
      <div ref="menuElement" class="rm-menu rm-context-menu" :style="{ left: rootMenu.x + 'px', top: rootMenu.y + 'px' }">
        <button :title="commandTitle('app.search')" @click="runRootMenu('search')"><Icon name="search" />搜索</button>
        <button @click="runRootMenu('tags')"><Icon name="tag" />标签索引</button>
        <button @click="runRootMenu('note')"><Icon name="noteAdd" />新建笔记</button>
        <button @click="runRootMenu('folder')"><Icon name="folderAdd" />新建目录</button>
        <button @click="runRootMenu('import')"><Icon name="import" />导入文档</button>
        <button @click="runRootMenu('images')"><Icon name="image" />图片管理</button>
      </div>
    </Teleport>
    <div class="rm-sidebar-foot">
      <button class="rm-foot-btn" :title="commandTitle('app.settings')" @click="ws.settings = 'index'"><Icon name="settings" />设置</button>
      <button class="rm-foot-btn" @click="emit('logout')"><Icon name="logout" />退出</button>
    </div>
  </div>
</template>
