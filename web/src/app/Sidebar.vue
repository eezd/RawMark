<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { basename } from './paths'
import { tree } from './tree'
import TreeNode from './TreeNode.vue'
import SearchPanel from './SearchPanel.vue'
import { createFolder, createNote, move, openSearch, ws } from './workspace'
import { sidebarViews } from '../plugins/registry'
import PluginMount from './PluginMount.vue'

const emit = defineEmits<{ logout: [] }>()
const rootDrop = ref(false)
const selectedView = ref('')
const currentView = computed(() => sidebarViews.get(selectedView.value))
watch(() => ws.searchOpen, () => { selectedView.value = '' })

function onRootDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('application/x-rawmark-path')) return
  e.preventDefault()
  rootDrop.value = true
}

function onRootDrop(e: DragEvent) {
  rootDrop.value = false
  const src = e.dataTransfer?.getData('application/x-rawmark-path')
  if (!src || !src.includes('/')) return
  e.preventDefault()
  void move(src, basename(src))
}
</script>

<template>
  <div class="rm-sidebar-inner">
    <div class="rm-sidebar-head">
      <span class="rm-brand">RawMark</span>
      <button class="rm-icon-btn" :class="{ on: ws.searchOpen }" title="搜索（Ctrl+Shift+F）" @click="ws.searchOpen ? (ws.searchOpen = false) : openSearch()">
        <Icon name="search" />
      </button>
      <button class="rm-icon-btn" title="新建笔记" @click="createNote('')"><Icon name="noteAdd" /></button>
      <button class="rm-icon-btn" title="新建文件夹" @click="createFolder('')"><Icon name="folderAdd" /></button>
      <button class="rm-icon-btn" title="导入" @click="ws.importing = ''"><Icon name="import" /></button>
    </div>
    <nav v-if="sidebarViews.size" class="rm-plugin-tabs" aria-label="侧栏视图">
      <button class="rm-btn" :class="{ on: !currentView }" @click="selectedView = ''">文件</button>
      <button v-for="[id, pluginView] in sidebarViews" :key="id" class="rm-btn" :class="{ on: selectedView === id }" @click="selectedView = id">{{ pluginView.title }}</button>
    </nav>
    <PluginMount v-if="currentView" :key="selectedView" :view="currentView" />
    <SearchPanel v-else-if="ws.searchOpen" />
    <div v-else class="rm-tree" :class="{ drop: rootDrop }" @dragover="onRootDragOver" @dragleave="rootDrop = false" @drop="onRootDrop">
      <ul class="rm-tree-list">
        <TreeNode v-for="node in tree" :key="node.path" :node="node" :depth="0" />
      </ul>
      <p v-if="!tree.length" class="rm-tree-empty">还没有笔记</p>
    </div>
    <div class="rm-sidebar-foot">
      <button class="rm-foot-btn" title="命令面板（F1）" @click="ws.switcher = '>'"><Icon name="command" />命令</button>
      <button class="rm-foot-btn" title="设置（Ctrl+,）" @click="ws.settings = 'index'"><Icon name="settings" />设置</button>
      <button class="rm-foot-btn" @click="emit('logout')"><Icon name="logout" />退出</button>
    </div>
  </div>
</template>
