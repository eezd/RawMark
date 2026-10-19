<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, setUnauthorizedHandler } from './api'
import AuthView from './AuthView.vue'
import AppStatus from './AppStatus.vue'
import { online, registerPwa } from './pwa'
import Toasts from './Toasts.vue'
import Workspace from './Workspace.vue'
import { stopWorkspace } from './workspace'

const phase = ref<'loading' | 'setup' | 'login' | 'ready' | 'error'>('loading')

async function check() {
  try {
    const s = await api.authState()
    // 请求成功比浏览器的网络状态提示更可靠（局域网和网络切换时可能不同步）。
    online.value = true
    phase.value = !s.setUp ? 'setup' : s.authenticated ? 'ready' : 'login'
  } catch {
    phase.value = 'error'
  }
}

setUnauthorizedHandler(() => {
  stopWorkspace()
  phase.value = 'login'
})
onMounted(() => {
  void check()
  void registerPwa()
})
</script>

<template>
  <AppStatus />
  <AuthView v-if="phase === 'setup' || phase === 'login'" :mode="phase" @done="phase = 'ready'" />
  <Workspace v-else-if="phase === 'ready'" @logout="phase = 'login'" />
  <div v-else class="rm-splash">
    <template v-if="phase === 'error'">
      <p>{{ online ? '无法连接到服务器' : '离线，无法加载笔记' }}</p>
      <button class="rm-btn" @click="check">重试</button>
    </template>
  </div>
  <Toasts />
</template>
