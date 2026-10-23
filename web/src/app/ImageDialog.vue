<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ApiError } from './api'
import Icon from './Icon.vue'
import { basename, dirname, isImage, joinPath } from './paths'
import { imageUrl, move, remove, replaceImage, ws } from './workspace'

const props = defineProps<{ path: string }>()
const dialog = ref<HTMLElement>()
const picker = ref<HTMLInputElement>()
const busy = ref(false)
const error = ref('')
const loadError = ref(false)
const dimensions = ref('')
const name = ref('')
const path = computed(() => props.path)
const entry = computed(() => ws.entries.find((e) => e.path === path.value))
const extension = computed(() => basename(path.value).slice(basename(path.value).lastIndexOf('.')))
const src = computed(() => imageUrl(path.value))
const siblings = computed(() => ws.entries.filter((e) => !e.dir && isImage(e.path) && dirname(e.path) === dirname(path.value)))
const index = computed(() => siblings.value.findIndex((e) => e.path === path.value))
const size = computed(() => entry.value ? (entry.value.size / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' KB' : '')

watch(path, (p) => { name.value = basename(p).slice(0, -extension.value.length); error.value = '' }, { immediate: true })
watch(src, () => { loadError.value = false; dimensions.value = '' })
onMounted(() => dialog.value?.focus())

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
  if (!base || base.startsWith('.') || /[/\\]/.test(base)) { error.value = '图片名称不能为空、以点开头或包含斜杠'; return }
  const to = joinPath(dirname(path.value), base + extension.value)
  if (to === path.value || busy.value) return
  busy.value = true
  error.value = ''
  try { await move(path.value, to) }
  catch (err) { error.value = err instanceof Error ? err.message : '修改后同步失败，请检查目录' }
  finally { busy.value = false }
}

async function replace(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || busy.value) return
  if (file.size > 50 * 1024 * 1024) { error.value = '图片不能超过 50 MB'; return }
  if (!file.name.toLowerCase().endsWith(extension.value.toLowerCase())) { error.value = '请选择与原图片扩展名相同的文件'; return }
  if (!confirm('替换会影响所有引用此路径的笔记，旧图片不会进入回收站。确定替换？')) return
  busy.value = true
  error.value = ''
  try { await replaceImage(path.value, file) }
  catch (err) { error.value = err instanceof ApiError ? err.message : '网络错误，替换结果尚未确认，请检查图片后再重试' }
  finally { busy.value = false }
}

async function trash() {
  if (busy.value || !confirm('将图片移入回收站？引用它的笔记会暂时无法显示此图片，恢复后可重新显示。')) return
  busy.value = true
  try { await remove(path.value) }
  finally { busy.value = false }
}
</script>

<template>
  <div class="rm-dialog-backdrop" @click.self="close" @keydown.esc.stop.prevent="close">
    <section ref="dialog" class="rm-dialog rm-image-dialog" tabindex="-1" role="dialog" aria-modal="true" aria-label="图片管理" :aria-busy="busy">
      <div class="rm-dialog-head">
        <h2>图片管理</h2>
        <button class="rm-icon-btn" title="关闭" :disabled="busy" @click="close"><Icon name="close" /></button>
      </div>
      <div class="rm-image-body">
        <p class="rm-image-path">{{ path }}</p>
        <div class="rm-image-preview">
          <p v-if="!entry">图片已不存在，请刷新目录</p>
          <p v-else-if="loadError" role="alert">图片无法预览，文件可能损坏或浏览器不支持此格式。</p>
          <img v-else :key="src" :src="src" :alt="basename(path)" @load="loaded" @error="loadError = true" />
        </div>
        <div class="rm-image-navigation">
          <button class="rm-btn" :disabled="busy || index <= 0" @click="select(-1)">上一张</button>
          <span>{{ index + 1 }} / {{ siblings.length }} · {{ dimensions }} {{ size }}</span>
          <button class="rm-btn" :disabled="busy || index >= siblings.length - 1" @click="select(1)">下一张</button>
        </div>
        <form class="rm-image-rename" @submit.prevent="rename">
          <label for="rm-image-name">图片名称</label>
          <div>
            <input id="rm-image-name" v-model="name" :disabled="busy || !entry" required />
            <span>{{ extension }}</span>
            <button class="rm-btn" :disabled="busy || !entry || name.trim() + extension === basename(path)">重命名</button>
          </div>
        </form>
        <p class="rm-image-hint">改名会更新笔记中的本地引用；替换保留原路径，请选择同格式图片（最大 50 MB）。</p>
        <p v-if="error" class="rm-auth-error" role="alert">{{ error }}</p>
        <div class="rm-image-actions">
          <input ref="picker" type="file" :accept="extension" hidden :disabled="busy" @change="replace" />
          <button class="rm-btn" :disabled="busy || !entry" @click="ws.moving = path">移动到…</button>
          <button class="rm-btn rm-btn-danger" :disabled="busy || !entry" @click="trash">移入回收站</button>
          <button class="rm-btn rm-btn-primary" :disabled="busy || !entry" @click="picker?.click()">{{ busy ? '处理中…' : '替换图片' }}</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.rm-image-dialog { max-width: 860px; width: min(860px, calc(100vw - 24px)); }
.rm-image-body { display: flex; flex-direction: column; gap: 14px; padding: 0 20px 20px; overflow-y: auto; font-size: var(--rm-ui-font-size); }
.rm-image-body p { margin: 0; }
.rm-image-path { overflow-wrap: anywhere; color: var(--rm-text-muted); }
.rm-image-preview { display: flex; align-items: center; justify-content: center; min-height: 140px; background: var(--rm-bg); border: 1px solid var(--rm-divider); border-radius: 6px; padding: 12px; }
.rm-image-preview img { display: block; max-width: 100%; max-height: 44dvh; object-fit: contain; }
.rm-image-navigation, .rm-image-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.rm-image-actions { flex-wrap: wrap; }
.rm-image-navigation span { font-size: var(--rm-ui-font-small); color: var(--rm-text-muted); text-align: center; }
.rm-image-navigation button, .rm-image-rename button { white-space: nowrap; }
.rm-image-rename { display: flex; flex-direction: column; gap: 8px; }
.rm-image-rename > div { display: flex; align-items: center; gap: 8px; }
.rm-image-rename input { min-width: 0; flex: 1; width: 0; border: 1px solid var(--rm-divider); background: var(--rm-bg); color: var(--rm-text); padding: 8px; border-radius: 6px; font: inherit; }
.rm-image-hint { color: var(--rm-text-muted); font-size: var(--rm-ui-font-small); line-height: 1.6; }
@media(max-width:767px), (pointer:coarse) { .rm-image-rename input { font-size: max(16px, var(--rm-ui-font-size)); } }
</style>
