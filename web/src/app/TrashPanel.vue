<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type TrashItem } from './api'
import Icon from './Icon.vue'
import SettingRow from './SettingRow.vue'
import { isImage } from './paths'
import { DEFAULTS, loadSettings, settings, SettingsAppearanceError, updateSettings } from './settings'
import { restore, toast } from './workspace'

const items = ref<TrashItem[] | null>(null)
const error = ref('')
const failures = ref<{ id: string; error: string }[]>([])
const busy = ref(false)
const saving = ref(false)

async function load() {
  try {
    items.value = await api.trash()
    error.value = ''
  } catch (cause) {
    error.value = '读取回收站失败：' + String(cause)
  }
}

async function retention(event: Event) {
  const input = event.target as HTMLInputElement
  const days = input.valueAsNumber
  if (!Number.isSafeInteger(days) || days < 0) {
    input.value = String(settings.trashRetentionDays)
    toast('请输入非负整数天数，0 表示永不自动删除')
    return
  }
  if (days === settings.trashRetentionDays) return
  saving.value = true
  try { await updateSettings({ trashRetentionDays: days }) }
  catch (cause) {
    toast('保存自动删除期限失败：' + String(cause))
    if (!(cause instanceof SettingsAppearanceError)) await loadSettings().catch(cause => toast('重新读取设置失败：' + String(cause)))
  } finally { saving.value = false }
}

async function doRestore(item: TrashItem) {
  if (busy.value) return
  busy.value = true
  try { await restore(item.id); await load() }
  finally { busy.value = false }
}

async function purge(item?: TrashItem) {
  if (busy.value) return
  if (!confirm(item ? `彻底删除“${item.path}”？此操作无法撤销。` : '清空回收站全部条目？此操作无法撤销。')) return
  busy.value = true
  failures.value = []
  try {
    if (item) await api.purge(item.id)
    else {
      const result = await api.clearTrash()
      failures.value = result.failed
      toast(`已永久删除 ${result.deleted.length} 项${result.failed.length ? `，${result.failed.length} 项失败` : ''}`)
    }
  } catch (cause) {
    toast('删除失败：' + String(cause))
  } finally {
    await load()
    busy.value = false
  }
}

const fmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
onMounted(load)
</script>

<template>
  <div>
    <SettingRow id="trash-retention" control="rm-trash-retention">
      <label class="rm-font-input"><input id="rm-trash-retention" type="number" min="0" step="1" :placeholder="String(DEFAULTS.trashRetentionDays)" :value="settings.trashRetentionDays" :disabled="saving" @change="retention" /> 天</label>
    </SettingRow>
    <SettingRow id="trash-clear"><button class="rm-btn rm-btn-danger" :disabled="busy || items?.length === 0" @click="purge()">清空全部</button></SettingRow>
    <p v-if="error" role="alert" class="rm-auth-error">{{ error }} <button class="rm-btn" :disabled="busy" @click="load">重试</button></p>
    <ul v-if="failures.length" role="alert"><li v-for="failure in failures" :key="failure.id">{{ items?.find(item => item.id === failure.id)?.path || failure.id }}：{{ failure.error }}</li></ul>
    <p v-if="items && !items.length" class="rm-tree-empty">回收站是空的</p>
    <p v-else-if="items === null && !error" class="rm-tree-empty" role="status">读取中…</p>
    <ul v-else class="rm-trash-list" :aria-busy="busy">
      <li v-for="item in items ?? []" :key="item.id">
        <Icon :name="item.dir ? 'folder' : isImage(item.path) ? 'image' : 'note'" />
        <div class="rm-trash-info">
          <span class="rm-trash-path">{{ item.path.replace(/\.md$/, '') }}</span>
          <span class="rm-trash-time">{{ fmt.format(item.deletedAt) }}</span>
        </div>
        <button class="rm-btn" :disabled="busy" @click="doRestore(item)">恢复</button>
        <button class="rm-btn rm-btn-danger" :disabled="busy" @click="purge(item)">彻底删除</button>
      </li>
    </ul>
  </div>
</template>
