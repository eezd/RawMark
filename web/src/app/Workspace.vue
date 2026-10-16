<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { api } from './api'
import EditorPane from './EditorPane.vue'
import Icon from './Icon.vue'
import NoteBanner from './NoteBanner.vue'
import { noteTitle } from './paths'
import Sidebar from './Sidebar.vue'
import TabBar from './TabBar.vue'
import { activeTab, flushAll, startWorkspace, stopWorkspace, toast, ws } from './workspace'

const emit = defineEmits<{ logout: [] }>()
const title = computed(() => (ws.active ? noteTitle(ws.active) : 'RawMark'))
const saving = computed(() => activeTab()?.dirty)

async function logout() {
  await flushAll()
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
function onTouchStart(e: TouchEvent) {
  touchX = e.touches[0].clientX < 24 ? e.touches[0].clientX : null
}
function onTouchMove(e: TouchEvent) {
  if (touchX !== null && e.touches[0].clientX - touchX > 60) {
    ws.sidebarOpen = true
    touchX = null
  }
}

onMounted(() => void startWorkspace())
onBeforeUnmount(stopWorkspace)
</script>

<template>
  <div class="rm-shell" :class="{ 'sidebar-open': ws.sidebarOpen }" @touchstart.passive="onTouchStart" @touchmove.passive="onTouchMove">
    <aside class="rm-sidebar"><Sidebar @logout="logout" /></aside>
    <div class="rm-backdrop" @click="ws.sidebarOpen = false" />
    <main class="rm-main">
      <header class="rm-mobile-bar">
        <button class="rm-icon-btn" title="目录" @click="ws.sidebarOpen = true"><Icon name="menu" :size="20" /></button>
        <span class="rm-mobile-title">{{ title }}</span>
        <span class="rm-save-state" :class="{ on: saving }" />
      </header>
      <TabBar />
      <NoteBanner />
      <EditorPane />
    </main>
  </div>
</template>
