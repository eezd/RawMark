<script setup lang="ts">
import { ref } from 'vue'
import Icon from './Icon.vue'
import { basename } from './paths'
import TrashDialog from './TrashDialog.vue'
import { tree } from './tree'
import TreeNode from './TreeNode.vue'
import { createFolder, createNote, move } from './workspace'

const emit = defineEmits<{ logout: [] }>()
const trashOpen = ref(false)
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
      <button class="rm-icon-btn" title="新建笔记" @click="createNote('')"><Icon name="noteAdd" /></button>
      <button class="rm-icon-btn" title="新建文件夹" @click="createFolder('')"><Icon name="folderAdd" /></button>
    </div>
    <div class="rm-tree" :class="{ drop: rootDrop }" @dragover="onRootDragOver" @dragleave="rootDrop = false" @drop="onRootDrop">
      <ul class="rm-tree-list">
        <TreeNode v-for="node in tree" :key="node.path" :node="node" :depth="0" />
      </ul>
      <p v-if="!tree.length" class="rm-tree-empty">还没有笔记</p>
    </div>
    <div class="rm-sidebar-foot">
      <button class="rm-foot-btn" @click="trashOpen = true"><Icon name="trash" />回收站</button>
      <button class="rm-foot-btn" @click="emit('logout')"><Icon name="logout" />退出</button>
    </div>
    <TrashDialog v-if="trashOpen" @close="trashOpen = false" />
  </div>
</template>
