<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { basename, inAssetDir, isImage, joinPath } from './paths'
import { expanded, type TreeNode } from './tree'
import { createFolder, createNote, move, openNote, remove, renameTarget, ws } from './workspace'

const props = defineProps<{ node: TreeNode; depth: number }>()

const image = computed(() => !props.node.dir && isImage(props.node.path))
const assetDir = computed(() => props.node.dir && inAssetDir(props.node.path))
const isOpen = computed(() => expanded.has(props.node.path))
const isActive = computed(() => (image.value ? ws.image : ws.active) === props.node.path)
const isRenaming = computed(() => ws.renaming === props.node.path)
const menuOpen = ref(false)
const dropTarget = ref(false)
const input = ref<HTMLInputElement>()
const draft = ref('')

// 长按打开菜单：Android 会触发 contextmenu，iOS Safari 不会，统一用触摸计时
const LONG_PRESS_MS = 500
let pressTimer: ReturnType<typeof setTimeout> | undefined
let pressStart: { x: number; y: number } | null = null
let longPressed = false

function onTouchStart(e: TouchEvent) {
  longPressed = false
  pressStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  pressTimer = setTimeout(() => {
    longPressed = true
    menuOpen.value = true
  }, LONG_PRESS_MS)
}

function onTouchMove(e: TouchEvent) {
  if (pressStart && Math.hypot(e.touches[0].clientX - pressStart.x, e.touches[0].clientY - pressStart.y) > 10) cancelPress()
}

function cancelPress() {
  clearTimeout(pressTimer)
  pressStart = null
}

function activate() {
  // 长按后松手产生的点击不打开笔记
  if (longPressed) {
    longPressed = false
    return
  }
  if (props.node.dir) {
    if (isOpen.value) expanded.delete(props.node.path)
    else expanded.add(props.node.path)
  } else if (image.value) ws.image = props.node.path
  else void openNote(props.node.path)
}

watch(
  isRenaming,
  async (on) => {
    if (!on) return
    draft.value = props.node.dir ? props.node.name : props.node.name.replace(/\.md$/, '')
    await nextTick()
    input.value?.focus()
    input.value?.select()
  },
  { immediate: true },
)

function commitRename() {
  if (!isRenaming.value) return
  ws.renaming = null
  const target = renameTarget(props.node.path, draft.value)
  if (target && target !== props.node.path) void move(props.node.path, target)
}

function runMenu(action: 'note' | 'folder' | 'import' | 'rename' | 'move' | 'share' | 'delete') {
  menuOpen.value = false
  const path = props.node.path
  if (action === 'note' || action === 'folder') {
    expanded.add(path)
    void (action === 'note' ? createNote(path) : createFolder(path))
  } else if (action === 'import') ws.importing = path
  else if (action === 'rename') ws.renaming = path
  else if (action === 'share') ws.sharing = path
  else if (action === 'move') ws.moving = path
  else void remove(path)
}

function cancelRename() {
  ws.renaming = null
}

// ---- 拖放移动（桌面端） ----
function onDragStart(e: DragEvent) {
  e.dataTransfer?.setData('application/x-rawmark-path', props.node.path)
  e.dataTransfer!.effectAllowed = 'move'
}

function onDragOver(e: DragEvent) {
  if (!props.node.dir || assetDir.value || !e.dataTransfer?.types.includes('application/x-rawmark-path')) return
  e.preventDefault()
  e.stopPropagation()
  dropTarget.value = true
}

function onDrop(e: DragEvent) {
  dropTarget.value = false
  const src = e.dataTransfer?.getData('application/x-rawmark-path')
  if (!props.node.dir || assetDir.value || !src) return
  e.preventDefault()
  e.stopPropagation()
  const to = joinPath(props.node.path, basename(src))
  if (src !== props.node.path && !props.node.path.startsWith(src + '/') && to !== src) void move(src, to)
}
</script>

<template>
  <li class="rm-tree-item">
    <div
      class="rm-tree-row"
      :class="{ active: isActive, drop: dropTarget, 'menu-open': menuOpen }"
      :style="{ paddingLeft: depth * 14 + 8 + 'px' }"
      :draggable="!isRenaming && !assetDir"
      @click="activate"
      @contextmenu.prevent="menuOpen = true"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend="cancelPress"
      @touchcancel="cancelPress"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @dragleave="dropTarget = false"
      @drop="onDrop"
    >
      <span class="rm-tree-chevron" :class="{ open: isOpen, hidden: !node.dir }"><Icon name="chevron" :size="12" /></span>
      <input
        v-if="isRenaming"
        ref="input"
        v-model="draft"
        class="rm-tree-input"
        @click.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
      <Icon v-if="image" name="image" :size="14" />
      <span v-if="!isRenaming" class="rm-tree-name">{{ node.dir ? node.name : node.name.replace(/\.md$/, '') }}</span>
      <button class="rm-icon-btn rm-tree-more" title="更多操作" @click.stop="menuOpen = !menuOpen">
        <Icon name="more" />
      </button>
      <div v-if="menuOpen" class="rm-menu" @click.stop>
        <template v-if="node.dir && !assetDir">
          <button @click="runMenu('note')"><Icon name="noteAdd" />新建笔记</button>
          <button @click="runMenu('folder')"><Icon name="folderAdd" />新建文件夹</button>
          <button @click="runMenu('import')"><Icon name="import" />导入</button>
        </template>
        <button v-if="image" @click="menuOpen = false; ws.image = node.path"><Icon name="image" />预览 / 替换图片</button>
        <button v-if="!assetDir" @click="runMenu('rename')"><Icon name="edit" />重命名</button>
        <button v-if="!assetDir" @click="runMenu('move')"><Icon name="folder" />移动到…</button>
        <button v-if="!image" @click="runMenu('share')"><Icon name="link" />分享</button>
        <button v-if="!assetDir" class="danger" @click="runMenu('delete')"><Icon name="trash" />删除</button>
      </div>
      <div v-if="menuOpen" class="rm-menu-backdrop" @click.stop="menuOpen = false" @contextmenu.prevent.stop="menuOpen = false" />
    </div>
    <ul v-if="node.dir && isOpen" class="rm-tree-list">
      <TreeNode v-for="child in node.children" :key="child.path" :node="child" :depth="depth + 1" />
    </ul>
  </li>
</template>
