<script setup lang="ts">
import type { ImportResult } from '@/pages/workspace/apis/type'
import { computed, onMounted, ref } from 'vue'
import { ApiError } from '@/http/axios'
import Icon from '../../../common/components/Icon.vue'
import { dirname } from '../../../common/utils/paths'
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

const dialog = ref<HTMLElement>()
const validation = computed(() => {
  if (!zipped.value && files.value.some(f => !f.name.endsWith('.md'))) return '请选择 .md 文件，或单独选择一个 ZIP'
  if (files.value.reduce((sum, file) => sum + file.size, 0) > 100_000_000) return '导入文件总量不能超过 100 MB'
  return ''
})
onMounted(() => dialog.value?.focus())

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
    error.value = '请输入导入文件夹名称'; return
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
    error.value = err instanceof ApiError ? err.message : '网络错误，导入结果尚未确认，请检查目标目录后再重试'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="rm-dialog-backdrop" @click.self="close" @keydown.esc.stop.prevent="close">
    <section ref="dialog" class="rm-dialog" tabindex="-1" role="dialog" aria-modal="true" aria-label="导入 Markdown" :aria-busy="busy">
      <div class="rm-dialog-head">
        <h2>导入 Markdown</h2>
        <button class="rm-icon-btn" title="关闭" :disabled="busy" @click="close">
          <Icon name="close" />
        </button>
      </div>
      <form class="rm-import-body" @submit.prevent="submit">
        <p class="rm-import-target">
          导入到：{{ dir || '根目录' }}
        </p>
        <template v-if="!result">
          <label>选择 Markdown 文件或一个 ZIP
            <input type="file" accept=".md,.zip" multiple :disabled="busy" @change="choose">
          </label>
          <label v-if="zipped">新建文件夹名称
            <input v-model="folder" :disabled="busy" required @input="error = ''">
          </label>
          <div v-else-if="files.length" class="rm-import-files">
            <label v-for="(file, i) in files" :key="i">{{ file.name }}
              <input v-model="names[i]" :disabled="busy" required aria-label="导入文件名称" @input="error = ''">
            </label>
          </div>
          <p class="rm-import-hint">
            总上传上限 100 MB。ZIP 保留目录层级，本地图片转为笔记独立附件；不覆盖已有内容。单独导入 Markdown 不包含本地附件。
          </p>
        </template>
        <div v-if="result" role="status">
          <p>导入完成：{{ result.notes }} 篇笔记，{{ result.assets }} 个附件（含独立副本）。</p>
          <details v-if="result.warnings.length" class="rm-import-warnings">
            <summary>{{ result.warnings.length }} 篇笔记有链接提示</summary>
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
          正在上传并整理，请勿关闭页面…
        </p>
        <div class="rm-import-actions">
          <el-button native-type="button" class="rm-btn" :disabled="busy" @click="close">
            {{ result ? '完成' : '取消' }}
          </el-button>
          <el-button v-if="!result" native-type="submit" class="rm-btn rm-btn-primary" :disabled="busy || !files.length || !!validation">
            {{ busy ? '导入中…' : '导入' }}
          </el-button>
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.rm-import-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 20px 20px;
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
