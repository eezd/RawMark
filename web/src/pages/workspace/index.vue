<script setup lang="ts">
import AppStatus from '@@/components/AppStatus/index.vue'

import Icon from '@@/components/Icon/index.vue'
import { t as translate } from '@@/i18n/runtime'
import { registerCommand } from '@@/utils/commands'
import { toast } from '@@/utils/notifications'
import { noteTitle } from '@@/utils/paths'
import { isCancel } from 'axios'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError } from '@/http/axios'
import SettingsDialog from '@/pages/settings/index.vue'
import { pinia } from '@/pinia'
import { SettingsAppearanceError, SIDEBAR_WIDTH, useSettingsStore } from '@/pinia/stores/settings'
import { useUserStore } from '@/pinia/stores/user'
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

const { settings, updateSettings } = useSettingsStore(pinia)

async function prepareReload() {
  await flushAll(); return readyToReload()
}

const user = useUserStore()
const router = useRouter()
async function prepareMaintenance() {
  await flushAll(); if (!readyToReload()) throw new Error(translate('workspace.finish_saving_uploading_or_working_352bc6'))
}
const title = computed(() => (ws.active ? noteTitle(ws.active) : 'RawMark'))
const resizingSidebar = ref(false)
// Custom fonts require authentication; preserve layout during initialization without briefly showing the default font.
const initializing = ref(true)

// Drag the sidebar's right edge to resize: update only CSS variables while dragging, then save settings on release.
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
        if (!isCancel(error)) toast(error instanceof SettingsAppearanceError ? error.message : translate('workspace.could_not_save_sidebar_width_8621fe'))
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
      toast(translate('workspace.finish_saving_pasting_uploading_or_670f95'))
      return
    }
    await user.logout()
  } catch (error) {
    if (isCancel(error)) return
    // The request layer already displays logout errors.
    return
  }
  stopWorkspace()
  await router.replace('/login')
}

// Mobile: swipe right from the screen's left edge to open the sidebar.
let touchX: number | null = null
// Swipe left to close the open sidebar; require primarily horizontal movement to avoid conflicts with list scrolling.
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

const unregisterLogout = registerCommand({ id: 'app.logout', get title() {
  return translate('common.sign_out_3ab8cc')
}, run: () => void logout() })

onMounted(async () => {
  try {
    await startWorkspace()
  } catch (err) {
    if (isCancel(err)) return; toast(translate('workspace.workspace_initialization_failed_reload_the_880958', { p0: err instanceof ApiError ? err.message : translate('common.network_or_local_storage_error') }))
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
        <div class="rm-sidebar-resize" :title="translate('workspace.drag_to_resize_b51545')" @pointerdown.prevent="startResize" />
      </aside>
      <div class="rm-backdrop" @click="ws.sidebarOpen = false" />
      <main class="rm-main">
        <header class="rm-mobile-bar">
          <button class="rm-icon-btn" :title="translate('workspace.folders_52daa7')" @click="ws.sidebarOpen = true">
            <Icon name="menu" />
          </button>
          <button class="rm-mobile-title" :title="translate('workspace.switch_note_649e31')" @click="ws.switcher = ''">
            {{ title }}
          </button>
          <button class="rm-icon-btn" :title="translate('workspace.quick_open_13e215')" @click="ws.switcher = ''">
            <Icon name="search" />
          </button>
          <button class="rm-icon-btn" :title="translate('common.command_928f87')" @click="ws.switcher = '>'">
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
