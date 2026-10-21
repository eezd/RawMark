<script setup lang="ts">
import { ref } from 'vue'
import { online, waitingWorker } from './pwa'
import { flushAll, readyToReload, toast } from './workspace'

const busy = ref(false)
const activated = ref(false)

async function update() {
  const worker = waitingWorker.value
  if ((!worker && !activated.value) || busy.value) return
  busy.value = true
  try {
    await flushAll()
    if (!readyToReload()) {
      toast('请先完成保存、图片上传或文件操作，再更新应用')
      return
    }
    if (!activated.value && worker) {
      // 等待新版激活后，仅刷新主动点击更新的页面。
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          if (worker.state !== 'activated' && worker.state !== 'redundant') return
          clearTimeout(timer)
          worker.removeEventListener('statechange', finish)
          if (worker.state === 'activated') resolve()
          else reject(new Error('新版本激活失败'))
        }
        const timer = setTimeout(() => {
          worker.removeEventListener('statechange', finish)
          reject(new Error('等待新版本超时'))
        }, 15000)
        worker.addEventListener('statechange', finish)
        worker.postMessage('ACTIVATE')
        finish()
      })
      activated.value = true
    }
    // 激活期间仍可能继续输入，刷新前再次确认；保留按钮供保存后重试。
    if (readyToReload()) location.reload()
    else toast('仍有未完成的保存或操作，请完成后再次点击刷新')
  } catch {
    toast('暂时无法更新，请稍后重试')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="!online || waitingWorker || activated" class="rm-app-status" role="status">
    <span v-if="!online">离线，无法加载或保存笔记</span>
    <template v-else-if="waitingWorker || activated">
      <span>有新版本</span>
      <button class="rm-btn" :disabled="busy" @click="update">{{ busy ? '正在保存…' : '保存并刷新' }}</button>
    </template>
  </div>
</template>
