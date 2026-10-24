<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, ApiError } from './api'
import { registerCommand } from './commands'
import EditorPane from './EditorPane.vue'
import KnowledgePanel from './KnowledgePanel.vue'
import EditorChrome from './EditorChrome.vue'
import Icon from './Icon.vue'
import SelectionToolbar from './SelectionToolbar.vue'
import MoveDialog from './MoveDialog.vue'
import ImportDialog from './ImportDialog.vue'
import ImageGallery from './ImageGallery.vue'
import ImageDialog from './ImageDialog.vue'
import NoteBanner from './NoteBanner.vue'
import OutlinePanel from './OutlinePanel.vue'
import QuickSwitcher from './QuickSwitcher.vue'
import SettingsDialog from './SettingsDialog.vue'
import { noteTitle } from './paths'
import { SIDEBAR_WIDTH, settings, SettingsAppearanceError, updateSettings } from './settings'
import Sidebar from './Sidebar.vue'
import TabBar from './TabBar.vue'
import { flushAll, readyToReload, startWorkspace, stopWorkspace, toast, ws } from './workspace'

const emit = defineEmits<{ logout: [] }>()
const title = computed(() => (ws.active ? noteTitle(ws.active) : 'RawMark'))
const resizingSidebar = ref(false)

// 拖动侧栏右缘调整宽度：拖动中只改 CSS 变量，松手后保存到设置
function startResize(e: PointerEvent) {
  const handle = e.currentTarget as HTMLElement
  handle.setPointerCapture(e.pointerId)
  resizingSidebar.value = true
  const startX = e.clientX
  const startWidth = settings.sidebarWidth
  let width = startWidth
  const onMove = (ev: PointerEvent) => {
    width = Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, startWidth + ev.clientX - startX)))
    document.documentElement.style.setProperty('--rm-sidebar-width', width + 'px')
  }
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('lostpointercapture', onUp)
    resizingSidebar.value = false
    if (width !== startWidth) updateSettings({ sidebarWidth: width }).catch(error => toast(error instanceof SettingsAppearanceError ? error.message : '保存侧栏宽度失败'))
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('lostpointercapture', onUp)
}

async function logout() {
  await flushAll()
  if (!readyToReload()) {
    toast('仍有未保存内容或正在处理粘贴、上传与文件操作，请完成后再退出')
    return
  }
  try {
    await api.logout()
  } catch {
    toast('退出失败')
    return
  }
  stopWorkspace()
  emit('logout')
}

// 移动端：从屏幕左边缘右滑打开侧栏
let touchX: number | null = null
// 侧栏打开时向左滑关闭（以水平方向为主，避免与列表上下滚动冲突）
let touchStart: { x: number; y: number } | null = null
function onTouchStart(e: TouchEvent) {
  const t = e.touches[0]
  touchX = t.clientX < 24 ? t.clientX : null
  touchStart = { x: t.clientX, y: t.clientY }
}
function onTouchMove(e: TouchEvent) {
  const t = e.touches[0]
  if (touchX !== null && t.clientX - touchX > 60) {
    ws.sidebarOpen = true
    touchX = null
  }
  if (ws.sidebarOpen && touchStart) {
    const dx = t.clientX - touchStart.x
    if (dx < -60 && Math.abs(t.clientY - touchStart.y) < Math.abs(dx) / 2) {
      ws.sidebarOpen = false
      touchStart = null
    }
  }
}

const unregisterLogout = registerCommand({ id: 'app.logout', title: '退出登录', run: () => void logout() })

onMounted(() => void startWorkspace().catch((err) => toast('工作区初始化失败，请重新加载：' + (err instanceof ApiError ? err.message : '网络或本地存储错误'))))
onBeforeUnmount(() => {
  unregisterLogout()
  stopWorkspace()
})
</script>

<template>
  <div
    class="rm-shell"
    :class="{ 'sidebar-open': ws.sidebarOpen, 'sidebar-collapsed': ws.sidebarCollapsed, 'sidebar-resizing': resizingSidebar, 'focus-mode': ws.focusMode }"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
  >
    <div class="rm-workspace">
    <aside class="rm-sidebar">
      <Sidebar @logout="logout" />
      <div class="rm-sidebar-resize" title="拖动调整宽度" @pointerdown.prevent="startResize" />
    </aside>
    <div class="rm-backdrop" @click="ws.sidebarOpen = false" />
    <main class="rm-main">
      <header class="rm-mobile-bar">
        <button class="rm-icon-btn" title="目录" @click="ws.sidebarOpen = true"><Icon name="menu" /></button>
        <button class="rm-mobile-title" title="切换笔记" @click="ws.switcher = ''">{{ title }}</button>
        <button class="rm-icon-btn" title="快速打开" @click="ws.switcher = ''"><Icon name="search" /></button>
        <button class="rm-icon-btn" title="命令" @click="ws.switcher = '>'"><Icon name="command" /></button>
      </header>
      <div v-show="ws.view === 'notes' && ws.images === null" class="rm-notes-view">
      <TabBar />
      <EditorChrome />
      <NoteBanner />
      <EditorPane />
      <SelectionToolbar />
      </div>
      <KnowledgePanel v-if="ws.view !== 'notes' && ws.images === null" />
      <ImageGallery v-if="ws.images !== null" :dir="ws.images" />
    </main>
    <Transition name="rm-outline-panel">
      <OutlinePanel v-if="ws.outlineOpen && !ws.focusMode && ws.active && ws.view === 'notes' && ws.images === null" />
    </Transition>
    </div>
    <QuickSwitcher v-if="ws.switcher !== null" />
    <SettingsDialog v-if="ws.settings" />
    <ImportDialog v-if="ws.importing !== null" :dir="ws.importing" @close="ws.importing = null" />
    <ImageDialog v-if="ws.image" :path="ws.image" />
    <MoveDialog v-if="ws.moving" :path="ws.moving" @close="ws.moving = null" />
  </div>
</template>
