<script setup lang="ts">
import { locale, t as translate } from '@@/i18n/runtime'

import { confirmAction } from '@@/utils/confirm'
import { basename, dirname, isImage, joinPath } from '@@/utils/paths'
import { computed, ref, watch } from 'vue'
import { ApiError } from '@/http/axios'
import { imageUrl, move, remove, replaceImage, ws } from '../workspace'

const props = defineProps<{ path: string }>()
const picker = ref<HTMLInputElement>()
const busy = ref(false)
const error = ref('')
const loadError = ref(false)
const dimensions = ref('')
const name = ref('')
const path = computed(() => props.path)
const entry = computed(() => ws.entries.find(e => e.path === path.value))
const extension = computed(() => basename(path.value).slice(basename(path.value).lastIndexOf('.')))
const src = computed(() => imageUrl(path.value))
const siblings = computed(() => ws.entries.filter(e => !e.dir && isImage(e.path) && dirname(e.path) === dirname(path.value)))
const index = computed(() => siblings.value.findIndex(e => e.path === path.value))
const size = computed(() => entry.value ? `${(entry.value.size / 1024).toLocaleString(locale.value, { maximumFractionDigits: 1 })} KB` : '')

watch(path, (p) => {
  name.value = basename(p).slice(0, -extension.value.length); error.value = ''
}, { immediate: true })
watch(src, () => {
  loadError.value = false; dimensions.value = ''
})

function close() {
  if (!busy.value) ws.image = null
}

function select(offset: number) {
  const target = siblings.value[index.value + offset]
  if (target && !busy.value) ws.image = target.path
}

function loaded(event: Event) {
  const image = event.target as HTMLImageElement
  dimensions.value = `${image.naturalWidth} × ${image.naturalHeight}`
}

async function rename() {
  const base = name.value.trim()
  if (!base || base.startsWith('.') || /[/\\]/.test(base)) {
    error.value = translate('workspace.image_names_cannot_be_empty_9499af'); return
  }
  const to = joinPath(dirname(path.value), base + extension.value)
  if (to === path.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await move(path.value, to, 'caller')
    if (!result.ok) error.value = result.error
  } catch (err) {
    error.value = err instanceof Error ? err.message : translate('workspace.change_applied_but_synchronization_failed_8a50cd')
  } finally {
    busy.value = false
  }
}

async function replace(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || busy.value) return
  if (file.size > 50 * 1024 * 1024) {
    error.value = translate('workspace.images_must_not_exceed_mb_61d721'); return
  }
  if (!file.name.toLowerCase().endsWith(extension.value.toLowerCase())) {
    error.value = translate('workspace.choose_a_file_with_the_97e882'); return
  }
  busy.value = true
  error.value = ''
  try {
    if (!await confirmAction(translate('workspace.replacing_this_image_affects_all_107587'))) return
    await replaceImage(path.value, file)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : translate('workspace.network_error_replacement_status_is_8b54f6')
  } finally {
    busy.value = false
  }
}

async function trash() {
  if (busy.value) return
  busy.value = true
  try {
    if (!await confirmAction(translate('workspace.move_this_image_to_trash_c979ba'))) return
    await remove(path.value)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <el-dialog :model-value="true" :title="translate('workspace.image_manager_07c502')" width="860px" class="rm-image-dialog" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" :before-close="close" @close="close">
    <div class="rm-image-body">
      <p class="rm-image-path">
        {{ path }}
      </p>
      <div class="rm-image-preview">
        <p v-if="!entry">
          {{ translate('workspace.this_image_no_longer_exists_50dc1d') }}
        </p>
        <p v-else-if="loadError" role="alert">
          {{ translate('workspace.cannot_preview_this_image_it_046111') }}
        </p>
        <img v-else :key="src" :src="src" :alt="basename(path)" @load="loaded" @error="loadError = true">
      </div>
      <div class="rm-image-navigation">
        <el-button class="rm-btn" :disabled="busy || index <= 0" @click="select(-1)">
          {{ translate('workspace.previous_image_bcf200') }}
        </el-button>
        <span>{{ index + 1 }} / {{ siblings.length }} · {{ dimensions }} {{ size }}</span>
        <el-button class="rm-btn" :disabled="busy || index >= siblings.length - 1" @click="select(1)">
          {{ translate('workspace.next_image_dcd4eb') }}
        </el-button>
      </div>
      <form class="rm-image-rename" @submit.prevent="rename">
        <label for="rm-image-name">{{ translate('workspace.image_name_edb98e') }}</label>
        <div>
          <el-input id="rm-image-name" v-model="name" :disabled="busy || !entry" required />
          <span>{{ extension }}</span>
          <el-button native-type="submit" class="rm-btn" :disabled="busy || !entry || name.trim() + extension === basename(path)">
            {{ translate('workspace.rename_0d0cba') }}
          </el-button>
        </div>
      </form>
      <p class="rm-image-hint">
        {{ translate('workspace.renaming_updates_local_references_in_bc3d12') }}
      </p>
      <p v-if="error" class="rm-auth-error" role="alert">
        {{ error }}
      </p>
      <div class="rm-image-actions">
        <input ref="picker" type="file" :accept="extension" hidden :disabled="busy" @change="replace">
        <el-button class="rm-btn" :disabled="busy || !entry" @click="ws.moving = path">
          {{ translate('workspace.move_to_0bee16') }}
        </el-button>
        <el-button class="rm-btn rm-btn-danger" :disabled="busy || !entry" @click="trash">
          {{ translate('workspace.move_to_trash_361bdf') }}
        </el-button>
        <el-button class="rm-btn rm-btn-primary" :disabled="busy || !entry" @click="picker?.click()">
          {{ busy ? translate('workspace.processing_d3d211') : translate('workspace.replace_image_dbc39d') }}
        </el-button>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
.rm-image-dialog {
  max-width: 860px;
  width: min(860px, calc(100vw - 24px));
}
.rm-image-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0;
  overflow-y: auto;
  font-size: var(--rm-ui-font-size);
}
.rm-image-body p {
  margin: 0;
}
.rm-image-path {
  overflow-wrap: anywhere;
  color: var(--rm-text-muted);
}
.rm-image-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 140px;
  background: var(--rm-bg);
  border: 1px solid var(--rm-divider);
  border-radius: 6px;
  padding: 12px;
}
.rm-image-preview img {
  display: block;
  max-width: 100%;
  max-height: 44dvh;
  object-fit: contain;
}
.rm-image-navigation,
.rm-image-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.rm-image-actions {
  flex-wrap: wrap;
}
.rm-image-navigation span {
  font-size: var(--rm-ui-font-small);
  color: var(--rm-text-muted);
  text-align: center;
}
.rm-image-navigation button,
.rm-image-rename button {
  white-space: nowrap;
}
.rm-image-rename {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rm-image-rename > div {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rm-image-rename input {
  min-width: 0;
  flex: 1;
  width: 0;
  border: 1px solid var(--rm-divider);
  background: var(--rm-bg);
  color: var(--rm-text);
  padding: 8px;
  border-radius: 6px;
  font: inherit;
}
.rm-image-hint {
  color: var(--rm-text-muted);
  font-size: var(--rm-ui-font-small);
  line-height: 1.6;
}
@media (max-width: 767px), (pointer: coarse) {
  .rm-image-rename input {
    font-size: max(16px, var(--rm-ui-font-size));
  }
}
</style>
