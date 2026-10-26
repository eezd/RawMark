<script setup lang="ts">
import type { TrashItem } from '@@/apis/trash/type'
import { clearTrashApi, getTrashApi, purgeTrashApi } from '@@/apis/trash'

import Icon from '@@/components/Icon/index.vue'

import { confirmAction } from '@@/utils/confirm'
import { toast } from '@@/utils/notifications'
import { isImage } from '@@/utils/paths'
import { isCancel } from 'axios'
import { onMounted, ref, watch } from 'vue'
import { pinia } from '@/pinia'
import { SettingsAppearanceError, useSettingsStore } from '@/pinia/stores/settings'
import { useUserStore } from '@/pinia/stores/user'
import SettingRow from './SettingRow.vue'

const props = defineProps<{ restoreNote: (id: string) => Promise<void> }>()

const { loadSettings, settings, updateSettings } = useSettingsStore(pinia)

const user = useUserStore()

const items = ref<TrashItem[] | null>(null)
const error = ref('')
const failures = ref<{ id: string, error: string }[]>([])
const busy = ref(false)
const saving = ref(false)
const retentionInput = ref(String(settings.trashRetentionDays))
watch(() => settings.trashRetentionDays, (days) => {
  retentionInput.value = String(days)
})

async function load() {
  try {
    items.value = (await getTrashApi()).data.items
    error.value = ''
  } catch (cause) {
    error.value = `读取回收站失败：${String(cause)}`
  }
}

async function retention(value: string) {
  const days = value.trim() ? Number(value) : NaN
  if (!Number.isSafeInteger(days) || days < 0) {
    retentionInput.value = String(settings.trashRetentionDays)
    toast('请输入非负整数天数，0 表示永不自动删除')
    return
  }
  if (days === settings.trashRetentionDays) return
  saving.value = true
  try {
    await updateSettings({ trashRetentionDays: days })
  } catch (cause) {
    if (isCancel(cause)) return
    toast(`保存自动删除期限失败：${String(cause)}`)
    if (!(cause instanceof SettingsAppearanceError)) {
      await loadSettings().catch((cause) => {
        if (!isCancel(cause)) toast(`重新读取设置失败：${String(cause)}`)
      })
    }
  } finally {
    saving.value = false
  }
}

async function doRestore(item: TrashItem) {
  if (busy.value) return
  busy.value = true
  try {
    await props.restoreNote(item.id); await load()
  } finally {
    busy.value = false
  }
}

async function purge(item?: TrashItem) {
  if (busy.value) return
  const version = user.getSessionVersion()
  busy.value = true
  failures.value = []
  let attempted = false
  try {
    if (!await confirmAction(item ? `彻底删除“${item.path}”？此操作无法撤销。` : '清空回收站全部条目？此操作无法撤销。')) return
    user.assertSession(version)
    attempted = true
    if (item) {
      await purgeTrashApi(item.id)
    } else {
      const result = (await clearTrashApi()).data
      failures.value = result.failed
      toast(`已永久删除 ${result.deleted.length} 项${result.failed.length ? `，${result.failed.length} 项失败` : ''}`)
    }
  } catch (cause) {
    if (isCancel(cause)) return
    toast(`删除失败：${String(cause)}`)
  } finally {
    if (attempted && version === user.getSessionVersion()) await load()
    busy.value = false
  }
}

const fmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
onMounted(load)
</script>

<template>
  <div>
    <SettingRow id="trash-retention" control="rm-trash-retention">
      <el-input id="rm-trash-retention" v-model="retentionInput" type="number" min="0" step="1" :disabled="saving" aria-label="自动删除天数" @change="retention" /><span>天</span>
    </SettingRow>
    <SettingRow id="trash-clear">
      <el-button class="rm-btn rm-btn-danger" :disabled="busy || items?.length === 0" @click="purge()">
        清空全部
      </el-button>
    </SettingRow>
    <p v-if="error" role="alert" class="rm-auth-error">
      {{ error }} <el-button class="rm-btn" :disabled="busy" @click="load">
        重试
      </el-button>
    </p>
    <ul v-if="failures.length" role="alert">
      <li v-for="failure in failures" :key="failure.id">
        {{ items?.find(item => item.id === failure.id)?.path || failure.id }}：{{ failure.error }}
      </li>
    </ul>
    <p v-if="items && !items.length" class="rm-tree-empty">
      回收站是空的
    </p>
    <p v-else-if="items === null && !error" class="rm-tree-empty" role="status">
      读取中…
    </p>
    <el-table v-else :data="items ?? []" row-key="id" :aria-busy="busy" empty-text="回收站是空的">
      <!-- @vue-generic {TrashItem} -->
      <el-table-column label="项目" min-width="170">
        <template #default="{ row: item }">
          <div class="rm-trash-name">
            <Icon :name="item.dir ? 'folder' : isImage(item.path) ? 'image' : 'note'" /><span>{{ item.path.replace(/\.md$/, '') }}</span>
          </div><small>{{ fmt.format(item.deletedAt) }}</small>
        </template>
      </el-table-column>
      <!-- @vue-generic {TrashItem} -->
      <el-table-column label="操作" width="160">
        <template #default="{ row: item }">
          <el-button text :disabled="busy" @click="doRestore(item)">
            恢复
          </el-button><el-button text type="danger" :disabled="busy" @click="purge(item)">
            彻底删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped lang="scss">
.rm-trash-name {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-wrap: anywhere;
}
small {
  color: var(--rm-text-muted);
  font-size: var(--rm-ui-font-small);
}
</style>
