<script setup lang="ts">
import Icon from '@@/components/Icon/index.vue'

import PluginMount from '@@/components/PluginMount/index.vue'
import { t as translate } from '@@/i18n/runtime'
import { sidebarViews } from '@@/plugins/registry'
import { commandTitle } from '@@/utils/commands'
import { basename } from '@@/utils/paths'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { dropDirectory, tree, treeIconTarget } from '../tree'
import { createFolder, createNote, move, openSearch, ws } from '../workspace'
import SearchPanel from './SearchPanel.vue'
import TreeIconPicker from './TreeIconPicker.vue'
import TreeNode from './TreeNode.vue'

const emit = defineEmits<{ logout: [] }>()
const rootMenu = ref<{ x: number, y: number } | null>(null)
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
  const close = () => {
    rootMenu.value = null
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close()
  }
  window.addEventListener('resize', close)
  window.addEventListener('keydown', onKeydown)
  onCleanup(() => {
    window.removeEventListener('resize', close)
    window.removeEventListener('keydown', onKeydown)
  })
})

function runRootMenu(action: 'search' | 'tags' | 'note' | 'folder' | 'import' | 'images') {
  rootMenu.value = null
  if (action === 'search') {
    openSearch()
  } else if (action === 'tags') {
    ws.view = 'tags'; ws.images = null; ws.sidebarOpen = false
  } else if (action === 'note' || action === 'folder') {
    selectedView.value = ''
    ws.searchOpen = false
    void (action === 'note' ? createNote('') : createFolder(''))
  } else if (action === 'import') {
    ws.importing = ''
  } else {
    ws.imagesAll = false; ws.images = ''
  }
}
const selectedView = ref('')
const currentView = computed(() => sidebarViews.get(selectedView.value))
watch(() => ws.searchOpen, () => {
  selectedView.value = ''
})

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

function clearDrop() {
  dropDirectory.value = null
}
function onTreeDragLeave(e: DragEvent) {
  if (e.currentTarget instanceof Element && e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
  clearDrop()
}
function onDragKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') clearDrop()
}
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
  treeIconTarget.value = null
})
</script>

<template>
  <div class="rm-sidebar-inner">
    <div class="rm-vault-heading">
      <button class="rm-icon-btn" :title="translate('workspace.collapse_sidebar_7b4c4c')" :aria-label="translate('workspace.collapse_sidebar_7b4c4c')" @click="ws.sidebarCollapsed = true; ws.sidebarOpen = false">
        <Icon name="menu" />
      </button>
      <button class="rm-tree-label" :title="translate('workspace.file_tree_actions_ac6020')" aria-haspopup="true" :aria-expanded="rootMenu !== null" @click="rootContext" @contextmenu="rootContext">
        {{ translate('workspace.files_ef81f8') }}
      </button>
    </div>
    <nav v-if="sidebarViews.size" class="rm-plugin-tabs" :aria-label="translate('workspace.sidebar_view_3d4d03')">
      <el-button class="rm-btn" :class="{ on: !currentView }" @click="selectedView = ''">
        {{ translate('workspace.files_39932f') }}
      </el-button>
      <el-button v-for="[id, pluginView] in sidebarViews" :key="id" class="rm-btn" :class="{ on: selectedView === id }" @click="selectedView = id">
        {{ pluginView.title }}
      </el-button>
    </nav>
    <PluginMount v-if="currentView" :key="selectedView" :view="currentView" />
    <SearchPanel v-else-if="ws.searchOpen" />
    <div v-else class="rm-tree" @contextmenu="rootContext" :class="{ drop: dropDirectory === '' }" @dragover="onRootDragOver" @dragleave="onTreeDragLeave" @drop="onRootDrop">
      <ul class="rm-tree-list">
        <TreeNode v-for="node in tree" :key="node.path" :node="node" :depth="0" />
      </ul>
      <p v-if="!tree.length" class="rm-tree-empty">
        {{ translate('workspace.no_notes_yet_871745') }}
      </p>
    </div>
    <Teleport v-if="rootMenu" to="body">
      <div class="rm-menu-backdrop rm-context-menu-backdrop" @click="rootMenu = null" @contextmenu.prevent="rootMenu = null" />
      <div ref="menuElement" class="rm-menu rm-context-menu" :style="{ left: `${rootMenu.x}px`, top: `${rootMenu.y}px` }">
        <button :title="commandTitle('app.search')" @click="runRootMenu('search')">
          <Icon name="search" />{{ translate('workspace.search_44ce7a') }}
        </button>
        <button @click="runRootMenu('tags')">
          <Icon name="tag" />{{ translate('workspace.tags_02b344') }}
        </button>
        <button @click="runRootMenu('note')">
          <Icon name="noteAdd" />{{ translate('workspace.new_note_d3d2d9') }}
        </button>
        <button @click="runRootMenu('folder')">
          <Icon name="folderAdd" />{{ translate('workspace.new_folder_d5f6f6') }}
        </button>
        <button @click="runRootMenu('import')">
          <Icon name="import" />{{ translate('workspace.import_documents_8b1183') }}
        </button>
        <button @click="runRootMenu('images')">
          <Icon name="image" />{{ translate('workspace.image_manager_07c502') }}
        </button>
      </div>
    </Teleport>
    <TreeIconPicker v-if="treeIconTarget" :key="treeIconTarget.path" :target="treeIconTarget" />
    <div class="rm-sidebar-foot">
      <button class="rm-foot-btn" :title="commandTitle('app.settings')" @click="ws.settings = 'index'">
        <Icon name="settings" />{{ translate('common.settings_df3d58') }}
      </button>
      <button class="rm-foot-btn" @click="emit('logout')">
        <Icon name="logout" />{{ translate('common.sign_out_498e1d') }}
      </button>
    </div>
  </div>
</template>
