<script setup lang="ts">
import type { ImportResult } from '@@/apis/files/type'

import { t as translate } from '@@/i18n/runtime'
import { dirname } from '@@/utils/paths'
import { computed, ref } from 'vue'
import { ApiError } from '@/http/axios'
import { expanded } from '../tree'
import { importNotes } from '../workspace'

const props = defineProps<{ dir: string }>()
const emit = defineEmits<{ close: [] }>()
const files = ref<File[]>([])
const folder = ref('')
const names = ref<string[]>([])
const busy = ref(false)
const error = ref('')
const result = ref<ImportResult | null>(null)
const zipped = computed(() => files.value.length === 1 && /\.zip$/i.test(files.value[0].name))

const validation = computed(() => {
  if (!zipped.value && files.value.some(f => !f.name.endsWith('.md'))) return translate('workspace.choose_markdown_files_or_a_a06bed')
  if (files.value.reduce((sum, file) => sum + file.size, 0) > 100_000_000) return translate('workspace.total_import_size_must_not_23ac37')
  return ''
})

function choose(event: Event) {
  const input = event.target as HTMLInputElement
  files.value = [...(input.files ?? [])]
  names.value = files.value.map(f => f.name)
  error.value = ''
  result.value = null
  if (zipped.value) folder.value = files.value[0].name.replace(/(?:\.md)?\.zip$/i, '')
  else folder.value = ''
}

function close() {
  if (!busy.value) emit('close')
}

async function submit() {
  if (busy.value || !files.value.length || validation.value || result.value) return
  if (zipped.value && !folder.value.trim()) {
    error.value = translate('workspace.enter_an_import_folder_name_6be2a3'); return
  }
  busy.value = true
  error.value = ''
  try {
    // 支持修改普通 Markdown 的目标文件名，以便处理同名冲突。
    const uploads = zipped.value ? files.value : files.value.map((file, i) => new File([file], names.value[i], { type: file.type }))
    result.value = await importNotes(props.dir, zipped.value ? folder.value.trim() : '', uploads)
    for (const p of result.value.paths) {
      for (let d = zipped.value ? p : dirname(p); d; d = dirname(d)) expanded.add(d)
    }
    // 导入文件成功后释放浏览器持有的文件，结果仍保留在弹窗中。
    files.value = []
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : translate('workspace.network_error_import_status_is_fb8726')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <el-dialog :model-value="true" :title="translate('workspace.import_markdown_fb4d82')" width="560px" class="rm-import-dialog" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" :before-close="close" @close="close">
    <el-form class="rm-import-body" label-position="top" :disabled="busy" @submit.prevent="submit">
      <p class="rm-import-target">
        {{ translate('workspace.import_to_020113') }}{{ dir || translate('workspace.root_folder_42ee28') }}
      </p>
      <template v-if="!result">
        <label>{{ translate('workspace.choose_markdown_files_or_a_88d508') }}
          <input type="file" accept=".md,.zip" multiple :disabled="busy" @change="choose">
        </label>
        <label v-if="zipped">{{ translate('workspace.new_folder_name_31b655') }}
          <el-input v-model="folder" required @input="error = ''" />
        </label>
        <div v-else-if="files.length" class="rm-import-files">
          <label v-for="(file, i) in files" :key="i">{{ file.name }}
            <el-input v-model="names[i]" required :aria-label="translate('workspace.import_folder_name_fba3f9')" @input="error = ''" />
          </label>
        </div>
        <p class="rm-import-hint">
          {{ translate('workspace.total_upload_limit_mb_zip_fa43d1') }}
        </p>
      </template>
      <div v-if="result" role="status">
        <p>{{ translate('workspace.import_complete_96bfaa') }}{{ result.notes }} {{ translate('workspace.notes_56c9da') }}{{ result.assets }} {{ translate('workspace.attachments_including_independent_copies_162f1e') }}</p>
        <details v-if="result.warnings.length" class="rm-import-warnings">
          <summary>{{ result.warnings.length }} {{ translate('workspace.notes_have_link_warnings_1462a8') }}</summary>
          <ul>
            <li v-for="warning in result.warnings" :key="warning">
              {{ warning }}
            </li>
          </ul>
        </details>
      </div>
      <p v-if="error || validation" class="rm-auth-error" role="alert">
        {{ error || validation }}
      </p>
      <p v-if="busy" role="status">
        {{ translate('workspace.uploading_and_organizing_keep_this_2be889') }}
      </p>
      <div class="rm-import-actions">
        <el-button native-type="button" class="rm-btn" :disabled="busy" @click="close">
          {{ result ? translate('workspace.done_c0b3fb') : translate('common.cancel_2cd0f3') }}
        </el-button>
        <el-button v-if="!result" native-type="submit" class="rm-btn rm-btn-primary" :disabled="busy || !files.length || !!validation">
          {{ busy ? translate('workspace.importing_2f58b6') : translate('common.import_576d81') }}
        </el-button>
      </div>
    </el-form>
  </el-dialog>
</template>

<style scoped lang="scss">
.rm-import-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 0;
  overflow-y: auto;
  font-size: var(--rm-ui-font-size);
}
.rm-import-body p {
  margin: 0;
}
.rm-import-body label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-wrap: anywhere;
}
.rm-import-body input {
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--rm-divider);
  border-radius: 6px;
  background: var(--rm-bg);
  color: var(--rm-text);
  font: inherit;
}
.rm-import-target,
.rm-import-hint {
  color: var(--rm-text-muted);
  overflow-wrap: anywhere;
}
.rm-import-hint {
  font-size: var(--rm-ui-font-small);
  line-height: 1.6;
}
.rm-import-files {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rm-import-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.rm-import-warnings {
  line-height: 1.6;
  overflow-wrap: anywhere;
}
@media (max-width: 767px), (pointer: coarse) {
  .rm-import-body input {
    font-size: max(16px, var(--rm-ui-font-size));
  }
}
</style>
