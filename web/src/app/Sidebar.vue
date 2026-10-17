<script setup lang="ts">
import { ref } from 'vue'
import Icon from './Icon.vue'
import { basename } from './paths'
import { tree } from './tree'
import TreeNode from './TreeNode.vue'
import SearchPanel from './SearchPanel.vue'
import { createFolder, createNote, move, openSearch, ws } from './workspace'

const emit = defineEmits<{ logout: [] }>()
const rootDrop = ref(false)

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
    </div>
    <SearchPanel v-if="ws.searchOpen" />
    <div v-else class="rm-tree" :class="{ drop: rootDrop }" @dragover="onRootDragOver" @dragleave="rootDrop = false" @drop="onRootDrop">
      <ul class="rm-tree-list">
        <TreeNode v-for="node in tree" :key="node.path" :node="node" :depth="0" />
      </ul>
      <p v-if="!tree.length" class="rm-tree-empty">还没有笔记</p>
    </div>
    <div class="rm-sidebar-foot">
      <button class="rm-foot-btn" title="命令面板（F1）" @click="ws.switcher = '>'"><Icon name="command" />命令</button>
      <button class="rm-foot-btn" @click="ws.trashOpen = true"><Icon name="trash" />回收站</button>
      <button class="rm-foot-btn" @click="emit('logout')"><Icon name="logout" />退出</button>
    </div>
  </div>
</template>
