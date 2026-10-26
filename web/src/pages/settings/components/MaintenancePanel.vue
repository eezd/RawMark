<script setup lang="ts">
import type { BackupKind, MaintenanceStatus } from '@@/apis/maintenance/type'

import type { AxiosHeaders, AxiosResponse } from 'axios'
import { getAuthStateApi } from '@@/apis/auth'
import { cancelBackupUploadApi, clearTempApi, exportBackupApi, exportLogsApi, exportNotesApi, getMaintenanceStatusApi, importSettingsApi, maintainIndexApi, resetSettingsApi, restoreBackupApi, startBackupUploadApi, uploadBackupChunkApi, validateBackupApi } from '@@/apis/maintenance'

import { locale, t as translate } from '@@/i18n/runtime'
import { refreshPlugins } from '@@/plugins/host'

import { confirmAction } from '@@/utils/confirm'
import { isCancel } from 'axios'
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { pinia } from '@/pinia'
import { useSettingsStore } from '@/pinia/stores/settings'
import { useUserStore } from '@/pinia/stores/user'
import SettingRow from './SettingRow.vue'

const props = defineProps<{ prepareMaintenance: () => Promise<void> }>()

const emit = defineEmits<{ changed: [], importNotes: [] }>()

const { flushSettings, loadSettings, reloadTheme } = useSettingsStore(pinia)

const user = useUserStore()

const busy = ref(false)
const progress = ref('')
const error = ref('')
const message = ref('')
const last = ref<MaintenanceStatus | null>(null)
const fullInput = ref<HTMLInputElement>()
const settingsInput = ref<HTMLInputElement>()
let mounted = true
onBeforeUnmount(() => {
  mounted = false
})
onMounted(async () => {
  try {
    const status = (await getMaintenanceStatusApi()).data; if (mounted) last.value = status
  } catch (cause) {
    if (mounted) error.value = translate('settings.could_not_load_maintenance_status_51d391', { p0: String(cause) })
  }
})
async function prepare() {
  await Promise.all([props.prepareMaintenance(), flushSettings()])
}
async function perform(label: string, action: (version: number) => Promise<void>) {
  if (busy.value) return
  const version = user.getSessionVersion()
  busy.value = true; progress.value = label; error.value = ''; message.value = ''
  try {
    await prepare()
    user.assertSession(version)
    await action(version)
    user.assertSession(version)
    if (mounted) {
      emit('changed'); last.value = (await getMaintenanceStatusApi()).data
    }
  } catch (cause) {
    if (mounted && !isCancel(cause)) error.value = String(cause)
  } finally {
    if (mounted) {
      busy.value = false; progress.value = ''
    }
  }
}
async function download(response: AxiosResponse<Blob, unknown, AxiosHeaders>, fallback: string) {
  const version = user.getSessionVersion()
  const blob = response.data
  user.assertSession(version)
  const header = String(response.headers.get('content-disposition') ?? '')
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1]
  const plain = /filename="([^"]+)"/i.exec(header)?.[1]
  const name = encoded ? decodeURIComponent(encoded) : plain ?? fallback
  const url = URL.createObjectURL(blob)
  const link = Object.assign(document.createElement('a'), { href: url, download: name })
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  message.value = translate('settings.export_file_generated_9d8f6c')
}
async function exportPackage(kind: BackupKind) {
  await perform(translate('settings.exporting_62731d'), async () => download(await exportBackupApi(kind), `rawmark-${kind}.zip`))
}
async function exportMarkdown() {
  await perform(translate('settings.exporting_notes_015ed1'), async () => download(await exportNotesApi(), 'rawmark-notes.zip'))
}
async function exportSystemLogs() {
  await perform(translate('settings.exporting_logs_2a89f7'), async () => download(await exportLogsApi(), 'rawmark-system-logs.zip'))
}
async function syncPreferences(completed: string, version: number) {
  try {
    user.assertSession(version)
    await loadSettings()
    user.assertSession(version)
    await reloadTheme()
    user.assertSession(version)
    await refreshPlugins()
    user.assertSession(version)
  } catch (cause) {
    user.assertSession(version)
    if (isCancel(cause)) throw cause
    throw new Error(translate('settings.but_synchronization_failed_54aebd', { p0: completed, p1: cause instanceof Error ? cause.message : String(cause) }), { cause })
  }
  message.value = completed
}
async function reset() {
  if (busy.value) return
  busy.value = true
  let confirmed = false
  try {
    confirmed = await confirmAction(translate('settings.reset_all_rawmark_preferences_shortcuts_9ab27e'))
  } finally {
    busy.value = false
  }
  if (!confirmed) return
  await perform(translate('settings.resetting_settings_39808b'), async (version) => {
    await resetSettingsApi(); await syncPreferences(translate('settings.settings_reset_previous_settings_backed_f4a4fa'), version)
  })
}
async function restore(kind: BackupKind, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]; input.value = ''
  if (!file) return
  await perform(translate('settings.uploading_6148b3'), async () => {
    if (file.size <= 0 || file.size > 2 * 1024 ** 3) throw new Error(translate('settings.the_compressed_backup_must_be_cdce88'))
    const version = user.getSessionVersion()
    const { id } = (await startBackupUploadApi({ kind, size: file.size })).data
    let submitted = false
    try {
      let offset = 0
      while (offset < file.size) {
        if (!mounted) throw new Error(translate('settings.upload_canceled_fb2c92'))
        const chunk = file.slice(offset, offset + 8 * 1024 ** 2)
        const result = (await uploadBackupChunkApi({ id, offset, body: chunk })).data
        if (result.offset !== offset + chunk.size) throw new Error(translate('settings.the_server_returned_inconsistent_upload_dd61f8'))
        offset = result.offset; progress.value = translate('settings.uploading_38466c', { p0: Math.round(offset / file.size * 100) })
      }
      progress.value = translate('settings.validating_backup_7a1f32')
      const summary = (await validateBackupApi(id)).data
      if (!mounted) throw new Error(translate('settings.import_canceled_08d7a9'))
      const description = kind === 'full'
        ? translate('settings.all_instance_data_will_be_4b1eb6')
        : translate('settings.all_preferences_and_plugin_configuration_11b0e4')
      if (!await confirmAction(translate('settings.backup_date_entries_expanded_size_b6755e', { p0: new Date(summary.createdAt).toLocaleString(locale.value), p1: summary.entries, p2: (summary.size / 1024 ** 2).toFixed(2), p3: description }))) return
      await prepare()
      user.assertSession(version)
      progress.value = kind === 'full' ? translate('settings.restoring_instance_keep_this_page_405c69') : translate('settings.importing_settings_078500')
      if (kind === 'settings') {
        await importSettingsApi(id); submitted = true
        await syncPreferences(translate('settings.settings_and_resources_imported_previous_f96d82'), version)
      } else {
        await restoreBackupApi(id); submitted = true
        user.invalidate(version)
        const recoveryVersion = user.getSessionVersion()
        for (let attempt = 0; attempt < 30; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 2000))
          if (recoveryVersion !== user.getSessionVersion()) return
          try {
            if (((await getAuthStateApi()).data).setUp) {
              location.reload(); return
            }
          } catch { /* 服务关闭和重新监听期间继续等待，最终超时会明确提示。 */ }
        }
        throw new Error(translate('settings.restore_request_submitted_the_service_b1d2c2'))
      }
    } finally {
      if (!submitted && version === user.getSessionVersion()) {
        try {
          await cancelBackupUploadApi(id)
        } catch (cause) {
          if (mounted) error.value = translate('settings.could_not_clean_up_the_ca0ac3', { p0: String(cause) })
        }
      }
    }
  })
}
async function index(operation: 'optimize' | 'rebuild') {
  await perform(operation === 'optimize' ? translate('settings.optimizing_index_0aabbf') : translate('settings.rebuilding_index_ae8fea'), async () => {
    await maintainIndexApi(operation); message.value = operation === 'optimize' ? translate('settings.index_optimized_dfe862') : translate('settings.index_rebuilt_d1763b')
  })
}
async function clearTemp() {
  await perform(translate('settings.cleaning_temporary_files_a62be6'), async () => {
    const result = (await clearTempApi()).data
    message.value = translate('settings.removed_files_freed_mib_027d71', { p0: result.files, p1: (result.bytes / 1024 ** 2).toFixed(2) })
    if (result.failed.length) error.value = translate('settings.some_files_could_not_be_628a24', { p0: result.failed.join('\n') })
  })
}
function importNotes() {
  if (!busy.value) emit('importNotes')
}
</script>

<template>
  <div class="rm-maintenance" :aria-busy="busy">
    <h3 class="rm-settings-group-title">
      {{ translate('settings.backup_and_migration_97dce0') }}
    </h3>
    <SettingRow id="backup-full">
      <el-button class="rm-btn" :disabled="busy" @click="exportPackage('full')">
        {{ translate('settings.export_764204') }}
      </el-button><el-button class="rm-btn" :disabled="busy" @click="fullInput!.click()">
        {{ translate('common.restore_e0534b') }}
      </el-button><input ref="fullInput" type="file" accept=".zip" hidden @change="restore('full', $event)">
    </SettingRow>
    <SettingRow id="backup-notes">
      <el-button class="rm-btn" :disabled="busy" @click="exportMarkdown">
        {{ translate('settings.export_764204') }}
      </el-button><el-button class="rm-btn" :disabled="busy" @click="importNotes">
        {{ translate('common.import_576d81') }}
      </el-button>
    </SettingRow>
    <SettingRow id="backup-settings">
      <el-button class="rm-btn" :disabled="busy" @click="exportPackage('settings')">
        {{ translate('settings.export_764204') }}
      </el-button><el-button class="rm-btn" :disabled="busy" @click="settingsInput!.click()">
        {{ translate('common.import_576d81') }}
      </el-button><input ref="settingsInput" type="file" accept=".zip" hidden @change="restore('settings', $event)">
    </SettingRow>
    <h3 class="rm-settings-group-title">
      {{ translate('settings.maintenance_tools_051093') }}
    </h3>
    <SettingRow id="index-optimize">
      <el-button class="rm-btn" :disabled="busy" @click="index('optimize')">
        {{ translate('settings.optimize_e1d83f') }}
      </el-button>
    </SettingRow>
    <SettingRow id="index-rebuild">
      <el-button class="rm-btn" :disabled="busy" @click="index('rebuild')">
        {{ translate('settings.rebuild_4b8d9d') }}
      </el-button>
    </SettingRow>
    <SettingRow id="temp-clear">
      <el-button class="rm-btn" :disabled="busy" @click="clearTemp">
        {{ translate('settings.clean_up_9d2998') }}
      </el-button>
    </SettingRow>
    <SettingRow id="settings-reset">
      <el-button class="rm-btn" :disabled="busy" @click="reset">
        {{ translate('settings.reset_cb5d68') }}
      </el-button>
    </SettingRow>
    <SettingRow id="logs-export">
      <el-button class="rm-btn" :disabled="busy" @click="exportSystemLogs">
        {{ translate('settings.export_764204') }}
      </el-button>
    </SettingRow>
    <p v-if="busy" role="status" aria-live="polite">
      {{ progress }}
    </p>
    <p v-if="message" role="status">
      {{ message }}
    </p>
    <p v-if="error" class="rm-auth-error" role="alert">
      {{ error }}
    </p>
    <p v-if="last?.error" class="rm-auth-error" role="alert">
      {{ translate('settings.last_maintenance_failed_283226') }}{{ last.error }}
    </p>
    <p v-if="last?.backup" class="rm-share-note">
      {{ translate('settings.pre_operation_backup_backups_b966a1') }}{{ last.backup }}
    </p>
  </div>
</template>

<style scoped>
.rm-maintenance [role='alert'] {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
