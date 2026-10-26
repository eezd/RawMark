<script setup lang="ts">
import type { StorageUsage } from '@@/apis/storage/type'

import { getStorageApi } from '@@/apis/storage'

import { locale, t as translate } from '@@/i18n/runtime'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import MaintenancePanel from './MaintenancePanel.vue'
import SettingRow from './SettingRow.vue'

const props = defineProps<{ prepareMaintenance: () => Promise<void> }>()
const emit = defineEmits<{ importNotes: [] }>()

const usage = ref<StorageUsage | null>(null)
const busy = ref(false)
const error = ref('')
let mounted = true
onBeforeUnmount(() => {
  mounted = false
})

const names: Record<StorageUsage['categories'][number]['id'], string> = { get vault() {
  return translate('settings.vault_7e16a8')
}, get databases() {
  return translate('settings.databases_263200')
}, get fonts() {
  return translate('common.font_078838')
}, get themes() {
  return translate('settings.themes_788db1')
}, get plugins() {
  return translate('settings.plugins_e806fb')
}, get other() {
  return translate('settings.other_d2909f')
} }
const colors = ['var(--rm-accent)', '#56a89c', '#bd9364', '#a88ac2', '#d57e8d', '#8d99a8']
const segments = computed(() => {
  let offset = 0
  return (usage.value?.categories ?? []).map((category, index) => {
    const percent = usage.value!.totalSize ? category.size / usage.value!.totalSize * 100 : 0
    const segment = { ...category, percent, offset, color: colors[index] }
    offset += percent
    return segment
  })
})

function size(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const unit = value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0
  return `${(value / 1024 ** unit).toLocaleString(locale.value, { maximumFractionDigits: unit ? 2 : 0 })} ${units[unit]}`
}
const updated = computed(() => usage.value ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'short', timeStyle: 'medium' }).format(usage.value.calculatedAt) : '')
async function scan() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const next = (await getStorageApi()).data
    if (mounted) usage.value = next
  } catch (cause) {
    if (mounted) error.value = translate('settings.could_not_calculate_storage_usage_6db82c', { p0: String(cause) })
  } finally {
    if (mounted) busy.value = false
  }
}
onMounted(scan)
</script>

<template>
  <div>
    <h3 class="rm-settings-group-title">
      {{ translate('settings.storage_usage_37ac17') }}
    </h3>
    <SettingRow id="storage">
      <el-button class="rm-btn" :disabled="busy" @click="scan">
        {{ busy ? translate('settings.calculating_884dbb') : translate('settings.refresh_aee887') }}
      </el-button>
    </SettingRow>
    <p class="rm-share-note">
      {{ translate('settings.includes_application_data_and_optional_95f18a') }}
    </p>
    <p v-if="error" class="rm-auth-error" role="alert">
      {{ error }}
    </p>
    <div v-if="usage" class="rm-storage" :aria-busy="busy">
      <div class="rm-storage-summary">
        <svg viewBox="0 0 120 120" role="img" :aria-label="translate('settings.storage_usage_by_category_614032')">
          <circle cx="60" cy="60" r="46" fill="none" stroke="var(--rm-divider)" stroke-width="14" />
          <circle v-for="segment in segments" :key="segment.id" cx="60" cy="60" r="46" pathLength="100" fill="none" :stroke="segment.color" stroke-width="14" :stroke-dasharray="`${segment.percent} ${100 - segment.percent}`" :stroke-dashoffset="-segment.offset" transform="rotate(-90 60 60)" />
        </svg>
        <div><span>{{ translate('settings.total_usage_d3d98e') }}</span><strong :title="translate('settings.bytes_8180a4', { p0: usage.totalSize })">{{ size(usage.totalSize) }}</strong><small>{{ translate('settings.calculated_239bdc') }}{{ updated }}</small></div>
      </div>
      <dl class="rm-storage-list">
        <template v-for="segment in segments" :key="segment.id">
          <div>
            <dt><i :style="{ background: segment.color }" />{{ names[segment.id] }}</dt><dd :title="translate('settings.bytes_8180a4', { p0: segment.size })">
              {{ size(segment.size) }} <small>{{ segment.percent.toFixed(1) }}%</small>
            </dd>
          </div>
          <template v-if="segment.id === 'fonts'">
            <div class="rm-storage-sub">
              <dt>{{ translate('settings.optional_built_in_fonts_05b309') }}</dt><dd>{{ size(usage.builtinFontsSize) }}</dd>
            </div>
            <div class="rm-storage-sub">
              <dt>{{ translate('common.import_font_50751a') }}</dt><dd>{{ size(usage.customFontsSize) }}</dd>
            </div>
          </template>
          <template v-if="segment.id === 'vault'">
            <div class="rm-storage-sub">
              <dt>{{ translate('settings.attachments_c7225d') }}</dt><dd :title="translate('settings.bytes_8180a4', { p0: usage.assetsSize })">
                {{ size(usage.assetsSize) }} <small>{{ (usage.totalSize ? usage.assetsSize / usage.totalSize * 100 : 0).toFixed(1) }}%</small>
              </dd>
            </div>
            <div class="rm-storage-sub">
              <dt>{{ translate('common.trash_ba35dc') }}</dt><dd :title="translate('settings.bytes_8180a4', { p0: usage.trashSize })">
                {{ size(usage.trashSize) }} <small>{{ (usage.totalSize ? usage.trashSize / usage.totalSize * 100 : 0).toFixed(1) }}%</small>
              </dd>
            </div>
          </template>
        </template>
      </dl>
    </div>
    <MaintenancePanel :prepare-maintenance="props.prepareMaintenance" @changed="scan" @import-notes="emit('importNotes')" />
  </div>
</template>

<style scoped>
.rm-storage-summary {
  display: flex;
  align-items: center;
  gap: 20px;
  margin: 20px 0;
}
.rm-storage-summary svg {
  width: 128px;
  height: 128px;
  flex-shrink: 0;
}
.rm-storage-summary strong {
  display: block;
  font-size: var(--rm-ui-font-heading);
  margin: 6px 0;
}
.rm-storage-summary small {
  display: block;
  color: var(--rm-text-muted);
}
.rm-storage-list {
  margin: 0;
}
.rm-storage-list > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}
.rm-storage-list dt {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rm-storage-list i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rm-storage-list dd {
  margin: 0;
  text-align: right;
}
.rm-storage-list small {
  display: inline-block;
  min-width: 52px;
  color: var(--rm-text-muted);
}
.rm-storage-list .rm-storage-sub {
  padding-left: 18px;
  color: var(--rm-text-muted);
}
@media (max-width: 480px) {
  .rm-storage-summary {
    gap: 12px;
    flex-wrap: wrap;
  }
  .rm-storage-summary svg {
    width: 100px;
    height: 100px;
  }
}
</style>
