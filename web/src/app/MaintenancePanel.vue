<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { api, type BackupKind, type MaintenanceStatus } from './api'
import { flushAll, readyToReload, ws } from './workspace'
import { flushSettings, loadSettings, reloadTheme } from './settings'
import { refreshPlugins } from '../plugins/host'
import SettingRow from './SettingRow.vue'

const emit = defineEmits<{ changed: [] }>()
const busy = ref(false)
const progress = ref('')
const error = ref('')
const message = ref('')
const last = ref<MaintenanceStatus | null>(null)
const fullInput = ref<HTMLInputElement>()
const settingsInput = ref<HTMLInputElement>()
let mounted = true
onBeforeUnmount(() => { mounted = false })
onMounted(async () => {
  try { const status = await api.maintenanceStatus(); if (mounted) last.value = status }
  catch (cause) { if (mounted) error.value = '读取维护状态失败：' + String(cause) }
})
async function prepare() {
  await Promise.all([flushAll(), flushSettings()])
  if (!readyToReload()) throw new Error('仍有未保存内容或正在上传、操作文件，请完成后再试')
}
async function perform(label: string, action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; progress.value = label; error.value = ''; message.value = ''
  try {
    await prepare()
    await action()
    if (mounted) { emit('changed'); last.value = await api.maintenanceStatus() }
  } catch (cause) { if (mounted) error.value = String(cause) }
  finally { if (mounted) { busy.value = false; progress.value = '' } }
}
async function download(response: Response, fallback: string) {
  const blob = await response.blob()
  const header = response.headers.get('Content-Disposition') ?? ''
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1]
  const plain = /filename="([^"]+)"/i.exec(header)?.[1]
  const name = encoded ? decodeURIComponent(encoded) : plain ?? fallback
  const url = URL.createObjectURL(blob)
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  link.click();setTimeout(() => URL.revokeObjectURL(url), 1000)
  message.value = '导出文件已生成'
}
async function exportPackage(kind: BackupKind) { await perform('正在导出…', async () => download(await api.exportBackup(kind), `rawmark-${kind}.zip`)) }
async function exportMarkdown() { await perform('正在导出笔记…', async () => download(await api.exportNotes(), 'rawmark-notes.zip')) }
async function exportSystemLogs() { await perform('正在导出日志…', async () => download(await api.exportLogs(), 'rawmark-system-logs.zip')) }
async function syncPreferences() { await loadSettings(); await reloadTheme(); await refreshPlugins() }
async function reset() {
  if (!confirm('恢复全部 RawMark 偏好？快捷键恢复默认，回收站期限恢复为 30 天，插件停用。保留笔记、账号、已安装资源、插件存储和本机标签页／布局。操作前会备份设置。')) return
  await perform('正在重置设置…', async () => { await api.resetSettings(); await syncPreferences(); message.value = '设置已重置，原设置已备份' })
}
async function restore(kind: BackupKind, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]; input.value = ''
  if (!file) return
  await perform('正在上传…', async () => {
    if (file.size <= 0 || file.size > 2 * 1024 ** 3) throw new Error('备份压缩大小须在 0–2 GiB 之间')
    const { id } = await api.startBackupUpload(kind, file.size)
    let submitted = false
    try {
      let offset = 0
      while (offset < file.size) {
        if (!mounted) throw new Error('已取消上传')
        const chunk = file.slice(offset, offset + 8 * 1024 ** 2)
        const result = await api.uploadBackupChunk(id, offset, chunk)
        if (result.offset !== offset + chunk.size) throw new Error('服务端返回的上传进度不一致')
        offset = result.offset; progress.value = `正在上传… ${Math.round(offset / file.size * 100)}%`
      }
      progress.value = '正在校验备份…'
      const summary = await api.validateBackup(id)
      if (!mounted) throw new Error('已取消导入')
      const description = kind === 'full'
        ? '将替换全部实例数据，恢复备份中的密码与 API 令牌，短暂维护后需要重新登录。'
        : '将替换全部偏好和插件配置，合并字体、主题和插件，同 ID 资源以导入包为准。'
      if (!confirm(`备份时间：${new Date(summary.createdAt).toLocaleString()}\n条目：${summary.entries}，展开大小：${(summary.size / 1024 ** 2).toFixed(2)} MiB\n${description}\n操作前会备份当前内容。确认继续？`)) return
      await prepare()
      progress.value = kind === 'full' ? '正在恢复实例，请勿关闭页面…' : '正在导入设置…'
      if (kind === 'settings') {
        await api.importSettings(id);submitted = true
        await syncPreferences();message.value = '设置与资源已导入，原设置已备份'
      } else {
        await api.restoreBackup(id);submitted = true
        for (let attempt = 0; attempt < 30; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 2000))
          try { if (!(await api.authState()).authenticated) { location.reload(); return } }
          catch { /* 服务关闭和重新监听期间继续等待，最终超时会明确提示。 */ }
        }
        throw new Error('恢复请求已提交，服务仍在维护，请稍后重新打开页面核对结果')
      }
    } finally {
      if (!submitted) {
        try { await api.cancelBackupUpload(id) }
        catch (cause) { if (mounted) error.value = '清理上传暂存失败：' + String(cause) }
      }
    }
  })
}
async function index(operation: 'optimize' | 'rebuild') {
  await perform(operation === 'optimize' ? '正在优化索引…' : '正在重建索引…', async () => {
    await api.maintainIndex(operation);message.value = operation === 'optimize' ? '索引已优化' : '索引已重建'
  })
}
async function clearTemp() {
  await perform('正在清理临时文件…', async () => {
    const result = await api.clearTemp()
    message.value = `已清理 ${result.files} 个文件，释放 ${(result.bytes / 1024 ** 2).toFixed(2)} MiB`
    if (result.failed.length) error.value = '部分清理失败：\n' + result.failed.join('\n')
  })
}
function importNotes() { if (!busy.value) { ws.settings = null; ws.importing = '' } }
</script>

<template>
  <div class="rm-maintenance" :aria-busy="busy">
    <h3 class="rm-settings-group-title">备份与迁移</h3>
    <SettingRow id="backup-full"><button class="rm-btn" :disabled="busy" @click="exportPackage('full')">导出</button><button class="rm-btn" :disabled="busy" @click="fullInput!.click()">恢复</button><input ref="fullInput" type="file" accept=".zip" hidden @change="restore('full', $event)" /></SettingRow>
    <SettingRow id="backup-notes"><button class="rm-btn" :disabled="busy" @click="exportMarkdown">导出</button><button class="rm-btn" :disabled="busy" @click="importNotes">导入</button></SettingRow>
    <SettingRow id="backup-settings"><button class="rm-btn" :disabled="busy" @click="exportPackage('settings')">导出</button><button class="rm-btn" :disabled="busy" @click="settingsInput!.click()">导入</button><input ref="settingsInput" type="file" accept=".zip" hidden @change="restore('settings', $event)" /></SettingRow>
    <h3 class="rm-settings-group-title">维护工具</h3>
    <SettingRow id="index-optimize"><button class="rm-btn" :disabled="busy" @click="index('optimize')">优化</button></SettingRow>
    <SettingRow id="index-rebuild"><button class="rm-btn" :disabled="busy" @click="index('rebuild')">重建</button></SettingRow>
    <SettingRow id="temp-clear"><button class="rm-btn" :disabled="busy" @click="clearTemp">清理</button></SettingRow>
    <SettingRow id="settings-reset"><button class="rm-btn" :disabled="busy" @click="reset">重置</button></SettingRow>
    <SettingRow id="logs-export"><button class="rm-btn" :disabled="busy" @click="exportSystemLogs">导出</button></SettingRow>
    <p v-if="busy" role="status" aria-live="polite">{{ progress }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" class="rm-auth-error" role="alert">{{ error }}</p>
    <p v-if="last?.error" class="rm-auth-error" role="alert">上次维护失败：{{ last.error }}</p>
    <p v-if="last?.backup" class="rm-share-note">操作前备份：backups/{{ last.backup }}</p>
  </div>
</template>

<style scoped>
.rm-maintenance [role="alert"] { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
