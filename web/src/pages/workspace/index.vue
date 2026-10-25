<script setup lang="ts">
import AppStatus from '@@/components/AppStatus.vue'
import { toast } from '@@/utils/notifications'
import { isCancel } from 'axios'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError } from '@/http/axios'
import { useUserStore } from '@/pinia/stores/user'
import Icon from '../../common/components/Icon.vue'
import { registerCommand } from '../../common/utils/commands'
import { noteTitle } from '../../common/utils/paths'
import { settings, SettingsAppearanceError, SIDEBAR_WIDTH, updateSettings } from '../../pinia/stores/settings'
import SettingsDialog from '../settings/index.vue'
import EditorChrome from './components/EditorChrome.vue'
import EditorPane from './components/EditorPane.vue'
import ImageDialog from './components/ImageDialog.vue'
import ImageGallery from './components/ImageGallery.vue'

import ImportDialog from './components/ImportDialog.vue'
import KnowledgePanel from './components/KnowledgePanel.vue'
import MoveDialog from './components/MoveDialog.vue'
import NoteBanner from './components/NoteBanner.vue'
import OutlinePanel from './components/OutlinePanel.vue'
import QuickSwitcher from './components/QuickSwitcher.vue'
import SelectionToolbar from './components/SelectionToolbar.vue'
import Sidebar from './components/Sidebar.vue'
import TabBar from './components/TabBar.vue'
import { flushAll, readyToReload, restore, startWorkspace, stopWorkspace, ws } from './workspace'

async function prepareReload() {
  await flushAll(); return readyToReload()
}

const user = useUserStore()
const router = useRouter()
async function prepareMaintenance() {
  await flushAll(); if (!readyToReload()) throw new Error('仍有未保存内容或正在上传、操作文件，请完成后再试')
}
const title = computed(() => (ws.active ? noteTitle(ws.active) : 'RawMark'))
const resizingSidebar = ref(false)
// 自定义字体需登录后读取；初始化期间保留排版，但不先显示默认字体。
const initializing = ref(true)

// 拖动侧栏右缘调整宽度：拖动中只改 CSS 变量，松手后保存到设置
function startResize(e: PointerEvent) {
  const version = user.getSessionVersion()
  const handle = e.currentTarget as HTMLElement
  handle.setPointerCapture(e.pointerId)
  resizingSidebar.value = true
  const startX = e.clientX
  const startWidth = settings.sidebarWidth
  let width = startWidth
  const onMove = (ev: PointerEvent) => {
    width = Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, startWidth + ev.clientX - startX)))
    document.documentElement.style.setProperty('--rm-sidebar-width', `${width}px`)
  }
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('lostpointercapture', onUp)
    resizingSidebar.value = false
    if (version !== user.getSessionVersion()) return
    if (width !== startWidth) {
      updateSettings({ sidebarWidth: width }).catch((error) => {
        if (!isCancel(error)) toast(error instanceof SettingsAppearanceError ? error.message : '保存侧栏宽度失败')
      })
    }
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('lostpointercapture', onUp)
}

async function logout() {
  const version = user.getSessionVersion()
  try {
    await flushAll()
    user.assertSession(version)
    if (!readyToReload()) {
      toast('仍有未保存内容或正在处理粘贴、上传与文件操作，请完成后再退出')
      return
    }
    await user.logout()
  } catch (error) {
    if (isCancel(error)) return
    // 注销错误已由请求层提示。
    return
  }
  stopWorkspace()
  await router.replace('/login')
}

// 移动端：从屏幕左边缘右滑打开侧栏
let touchX: number | null = null
// 侧栏打开时向左滑关闭（以水平方向为主，避免与列表上下滚动冲突）
let touchStart: { x: number, y: number } | null = null
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

onMounted(async () => {
  try {
    await startWorkspace()
  } catch (err) {
    if (isCancel(err)) return; toast(`工作区初始化失败，请重新加载：${err instanceof ApiError ? err.message : '网络或本地存储错误'}`)
  } finally {
    initializing.value = false
  }
})
onBeforeUnmount(() => {
  unregisterLogout()
  stopWorkspace()
})
</script>

<template>
  <AppStatus :before-reload="prepareReload" />
  <div
    class="rm-shell"
    :style="initializing ? { opacity: 0, pointerEvents: 'none' } : undefined"
    :inert="initializing"
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
          <button class="rm-icon-btn" title="目录" @click="ws.sidebarOpen = true">
            <Icon name="menu" />
          </button>
          <button class="rm-mobile-title" title="切换笔记" @click="ws.switcher = ''">
            {{ title }}
          </button>
          <button class="rm-icon-btn" title="快速打开" @click="ws.switcher = ''">
            <Icon name="search" />
          </button>
          <button class="rm-icon-btn" title="命令" @click="ws.switcher = '>'">
            <Icon name="command" />
          </button>
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
    <SettingsDialog v-if="ws.settings" v-model="ws.settings" :prepare-maintenance="prepareMaintenance" :restore-note="restore" @import-notes="ws.settings = null; ws.importing = ''" />
    <ImportDialog v-if="ws.importing !== null" :dir="ws.importing" @close="ws.importing = null" />
    <ImageDialog v-if="ws.image" :path="ws.image" />
    <MoveDialog v-if="ws.moving" :path="ws.moving" @close="ws.moving = null" />
  </div>
</template>
