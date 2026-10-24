<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { basename, dirname, inAssetDir, isImage, joinPath } from './paths'
import { contextSelection, dropDirectory, expanded, selectedPaths, selectPath, type TreeNode } from './tree'
import { batchFiles, exportFiles } from './batch'
import { createFolder, createNote, move, openNote, renameTarget, ws } from './workspace'

const props = defineProps<{ node: TreeNode; depth: number }>()

const image = computed(() => !props.node.dir && isImage(props.node.path))
const assetDir = computed(() => props.node.dir && inAssetDir(props.node.path))
const isOpen = computed(() => expanded.has(props.node.path))
const isActive = computed(() => (image.value ? ws.image : ws.active) === props.node.path)
const isRenaming = computed(() => ws.renaming === props.node.path)
const menuOpen = ref(false)
const row = ref<HTMLElement>()
const menuElement = ref<HTMLElement>()
const menuPosition = ref({ left: 0, top: 0 })
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
    showMenu()
  }, LONG_PRESS_MS)
}

function onTouchMove(e: TouchEvent) {
  if (pressStart && Math.hypot(e.touches[0].clientX - pressStart.x, e.touches[0].clientY - pressStart.y) > 10) cancelPress()
}

function cancelPress() {
  clearTimeout(pressTimer)
  pressStart = null
}

function activate(event: MouseEvent) {
  // 长按后松手产生的点击不打开笔记
  if (longPressed) {
    longPressed = false
    return
  }
  selectPath(props.node.path, event)
  if (event.ctrlKey || event.metaKey || event.shiftKey) return
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

function runMenu(action: 'note' | 'folder' | 'import' | 'images' | 'rename' | 'move' | 'delete' | 'export') {
  menuOpen.value = false
  const path = props.node.path
  if (action === 'note' || action === 'folder') {
    expanded.add(path)
    void (action === 'note' ? createNote(path) : createFolder(path))
  } else if (action === 'import') ws.importing = path
  else if (action === 'images') { ws.imagesAll = false; ws.images = path }
  else if (action === 'rename') ws.renaming = path
  else if (action === 'move') ws.moving = [...selectedPaths]
  else if (action === 'export') void exportFiles([...selectedPaths])
  else void batchFiles('delete', [...selectedPaths])
}

function showMenu() {
  contextSelection(props.node.path)
  menuOpen.value = true
}

watch(menuOpen, async (open, _previous, onCleanup) => {
  if (!open) return
  const close = () => { menuOpen.value = false }
  window.addEventListener('resize', close)
  onCleanup(() => window.removeEventListener('resize', close))
  await nextTick()
  if (!menuOpen.value || !row.value || !menuElement.value) return
  const anchor = row.value.getBoundingClientRect()
  const { width, height } = menuElement.value.getBoundingClientRect()
  menuPosition.value = {
    left: Math.max(4, Math.min(anchor.right - width, innerWidth - width - 4)),
    top: Math.max(4, Math.min(anchor.bottom, innerHeight - height - 4)),
  }
})

function cancelRename() {
  ws.renaming = null
}

// ---- 拖放移动（桌面端） ----
function onDragStart(e: DragEvent) {
  e.dataTransfer?.setData('application/x-rawmark-path', props.node.path)
  e.dataTransfer!.effectAllowed = 'move'
}

function onDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('application/x-rawmark-path')) return
  e.preventDefault()
  e.stopPropagation()
  dropDirectory.value = assetDir.value ? null : (props.node.dir ? props.node.path : dirname(props.node.path))
}

function onDrop(e: DragEvent) {
  dropDirectory.value = null
  if (!e.dataTransfer?.types.includes('application/x-rawmark-path')) return
  e.preventDefault()
  e.stopPropagation()
  const src = e.dataTransfer.getData('application/x-rawmark-path')
  if (assetDir.value || !src) return
  const dir = props.node.dir ? props.node.path : dirname(props.node.path)
  const to = joinPath(dir, basename(src))
  if (src !== dir && !dir.startsWith(src + '/') && to !== src) void move(src, to)
}
</script>

<template>
  <li class="rm-tree-item">
    <div
      ref="row"
      class="rm-tree-row"
      :class="{ active: isActive, selected: selectedPaths.has(node.path), drop: node.dir && dropDirectory === node.path, 'menu-open': menuOpen }"
      :style="{ paddingLeft: depth * 14 + 8 + 'px' }"
      :draggable="!isRenaming && !assetDir"
      role="treeitem"
      :aria-selected="selectedPaths.has(node.path)"
      @click="activate"
      @contextmenu.prevent.stop="showMenu"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend="cancelPress"
      @touchcancel="cancelPress"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @drop="onDrop"
    >
      <span class="rm-tree-chevron" :class="{ open: isOpen, hidden: !node.dir }"><Icon name="chevron" :size="16" /></span>
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
      <Icon v-if="image" name="image" :size="18" />
      <span v-if="!isRenaming" class="rm-tree-name">{{ node.dir ? node.name : node.name.replace(/\.md$/, '') }}</span>
      <button v-if="!isRenaming" class="rm-icon-btn rm-tree-more" title="更多操作" @click.stop="menuOpen ? (menuOpen = false) : showMenu()">
        <Icon name="more" />
      </button>
    </div>
    <Teleport to="body">
      <div v-if="menuOpen" class="rm-menu-backdrop rm-tree-menu-backdrop" @click.stop="menuOpen = false" @contextmenu.prevent.stop="menuOpen = false" />
      <div v-if="menuOpen" ref="menuElement" class="rm-menu rm-tree-menu" :style="{ left: menuPosition.left + 'px', top: menuPosition.top + 'px' }" @click.stop>
        <template v-if="node.dir && !assetDir && selectedPaths.size === 1">
          <button @click="runMenu('note')"><Icon name="noteAdd" />新建笔记</button>
          <button @click="runMenu('folder')"><Icon name="folderAdd" />新建文件夹</button>
          <button @click="runMenu('images')"><Icon name="image" />图片管理</button>
          <button @click="runMenu('import')"><Icon name="import" />导入</button>
        </template>
        <button v-if="image && selectedPaths.size === 1" @click="menuOpen = false; ws.image = node.path"><Icon name="image" />预览 / 替换图片</button>
        <button v-if="!assetDir && selectedPaths.size === 1" @click="runMenu('rename')"><Icon name="edit" />重命名</button>
        <button v-if="!assetDir" @click="runMenu('move')"><Icon name="folder" />移动到…</button>
        <button @click="runMenu('export')"><Icon name="note" />导出 Markdown</button>
        <button v-if="!assetDir" class="danger" @click="runMenu('delete')"><Icon name="trash" />删除</button>
      </div>
    </Teleport>
    <ul v-if="node.dir && isOpen" class="rm-tree-list">
      <TreeNode v-for="child in node.children" :key="child.path" :node="child" :depth="depth + 1" />
    </ul>
  </li>
</template>

<style scoped>
.rm-tree-menu { position: fixed; right: auto; z-index: 45; width: max-content; min-width: 0; max-width: calc(100vw - 8px); max-height: calc(100dvh - 8px); box-sizing: border-box; overflow: auto; }
.rm-tree-menu button { flex: none; white-space: nowrap; }
.rm-tree-menu-backdrop { z-index: 44; }
</style>
