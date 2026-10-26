<script setup lang="ts">
import type { TrashItem } from '@@/apis/trash/type'

import { clearTrashApi, getTrashApi, purgeTrashApi } from '@@/apis/trash'
import Icon from '@@/components/Icon/index.vue'

import { locale, t as translate } from '@@/i18n/runtime'

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
    error.value = translate('settings.could_not_load_trash_0d559f', { p0: String(cause) })
  }
}

async function retention(value: string) {
  const days = value.trim() ? Number(value) : NaN
  if (!Number.isSafeInteger(days) || days < 0) {
    retentionInput.value = String(settings.trashRetentionDays)
    toast(translate('settings.enter_a_non_negative_number_aff4a0'))
    return
  }
  if (days === settings.trashRetentionDays) return
  saving.value = true
  try {
    await updateSettings({ trashRetentionDays: days })
  } catch (cause) {
    if (isCancel(cause)) return
    toast(translate('settings.could_not_save_trash_retention_db584b', { p0: String(cause) }))
    if (!(cause instanceof SettingsAppearanceError)) {
      await loadSettings().catch((cause) => {
        if (!isCancel(cause)) toast(translate('settings.could_not_reload_settings_744b6a', { p0: String(cause) }))
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
    if (!await confirmAction(item ? translate('settings.permanently_delete_this_cannot_be_8a3d3f', { p0: item.path }) : translate('settings.empty_all_trash_this_cannot_cf818b'))) return
    user.assertSession(version)
    attempted = true
    if (item) {
      await purgeTrashApi(item.id)
    } else {
      const result = (await clearTrashApi()).data
      failures.value = result.failed
      toast(result.failed.length
        ? translate('settings.permanently_deleted_with_failures', { count: result.deleted.length, failed: result.failed.length })
        : translate('settings.permanently_deleted_items_4712cc', { count: result.deleted.length }))
    }
  } catch (cause) {
    if (isCancel(cause)) return
    toast(translate('common.could_not_delete_9619d7', { p0: String(cause) }))
  } finally {
    if (attempted && version === user.getSessionVersion()) await load()
    busy.value = false
  }
}

const fmt = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'short', timeStyle: 'short' }))
onMounted(load)
</script>

<template>
  <div>
    <SettingRow id="trash-retention" control="rm-trash-retention">
      <el-input id="rm-trash-retention" v-model="retentionInput" type="number" min="0" step="1" :disabled="saving" :aria-label="translate('settings.trash_retention_days_f4ee2a')" @change="retention" /><span>{{ translate('settings.days_49da61') }}</span>
    </SettingRow>
    <SettingRow id="trash-clear">
      <el-button class="rm-btn rm-btn-danger" :disabled="busy || items?.length === 0" @click="purge()">
        {{ translate('settings.empty_trash_1b5909') }}
      </el-button>
    </SettingRow>
    <p v-if="error" role="alert" class="rm-auth-error">
      {{ error }} <el-button class="rm-btn" :disabled="busy" @click="load">
        {{ translate('common.retry_b8784c') }}
      </el-button>
    </p>
    <ul v-if="failures.length" role="alert">
      <li v-for="failure in failures" :key="failure.id">
        {{ items?.find(item => item.id === failure.id)?.path || failure.id }}：{{ failure.error }}
      </li>
    </ul>
    <p v-if="items && !items.length" class="rm-tree-empty">
      {{ translate('settings.trash_is_empty_9c6705') }}
    </p>
    <p v-else-if="items === null && !error" class="rm-tree-empty" role="status">
      {{ translate('settings.loading_346ff6') }}
    </p>
    <el-table v-else :data="items ?? []" row-key="id" :aria-busy="busy" :empty-text="translate('settings.trash_is_empty_9c6705')">
      <!-- @vue-generic {TrashItem} -->
      <el-table-column :label="translate('settings.item_79f326')" min-width="170">
        <template #default="{ row: item }">
          <div class="rm-trash-name">
            <Icon :name="item.dir ? 'folder' : isImage(item.path) ? 'image' : 'note'" /><span>{{ item.path.replace(/\.md$/, '') }}</span>
          </div><small>{{ fmt.format(item.deletedAt) }}</small>
        </template>
      </el-table-column>
      <!-- @vue-generic {TrashItem} -->
      <el-table-column :label="translate('settings.actions_ed31fb')" width="160">
        <template #default="{ row: item }">
          <el-button text :disabled="busy" @click="doRestore(item)">
            {{ translate('common.restore_e0534b') }}
          </el-button><el-button text type="danger" :disabled="busy" @click="purge(item)">
            {{ translate('settings.delete_permanently_7aa6d0') }}
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
