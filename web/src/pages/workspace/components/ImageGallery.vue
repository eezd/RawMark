<script setup lang="ts">
import type { Entry } from '@@/apis/tree/type'
import Icon from '@@/components/Icon/index.vue'
import { toast } from '@@/utils/notifications'
import { basename, hiddenAssetPath, imageInFolder, isImage } from '@@/utils/paths'
import { computed, onMounted, ref } from 'vue'
import { metadata, refreshMetadata } from '../metadata'
import { cleanupImages, imageUrl, openReference, uploadFolderImages, ws } from '../workspace'

const props = defineProps<{ dir: string }>()
const query = ref('')
const format = ref('')
const usage = ref('all')
const sort = ref('modified')
const list = ref(false)
const selected = ref('')
const dimensions = ref('')
const broken = ref(false)
const picker = ref<HTMLInputElement>()
const busy = ref(false)
const report = ref<string[]>([])
const cleanupCandidates = ref<Entry[] | null>(null)
const cleanupSelected = ref<string[]>([])
const uploadDir = ref(props.dir)
const directories = computed(() => ws.entries.filter(entry => entry.dir && !hiddenAssetPath(entry.path)))
const allImages = computed(() => ws.entries.filter(entry => !entry.dir && isImage(entry.path)))
const scopeImages = computed(() => allImages.value.filter(entry => ws.imagesAll || imageInFolder(entry.path, props.dir)))
const references = computed(() => {
  const result = new Map<string, { path: string, title: string, line: number }[]>()
  for (const note of metadata.notes) {
    for (const asset of note.assets) {
      const refs = result.get(asset.target) ?? []
      if (!refs.some(ref => ref.path === note.path)) refs.push({ path: note.path, title: note.title, line: asset.line })
      result.set(asset.target, refs)
    }
  }
  return result
})
const certain = computed(() => metadata.ready && !metadata.error && !metadata.notes.some(note => note.warnings.length))
const images = computed(() => scopeImages.value.filter((entry) => {
  const count = references.value.get(entry.path)?.length ?? 0
  return entry.path.toLocaleLowerCase().includes(query.value.toLocaleLowerCase()) && (!format.value || entry.path.toLowerCase().endsWith(`.${format.value}`)) && (usage.value === 'all' || (certain.value && (usage.value === 'used' ? count > 0 : count === 0)))
}).sort((a, b) => sort.value === 'name' ? a.path.localeCompare(b.path, 'zh-CN', { numeric: true }) : sort.value === 'size' ? b.size - a.size : b.mtime - a.mtime))
const types = computed(() => [...new Set(scopeImages.value.map(entry => entry.path.slice(entry.path.lastIndexOf('.') + 1).toLowerCase()))].sort())
const totalSize = computed(() => scopeImages.value.reduce((sum, entry) => sum + entry.size, 0))
const current = computed(() => scopeImages.value.find(entry => entry.path === selected.value))
const currentRefs = computed(() => references.value.get(selected.value) ?? [])
const orphans = computed(() => certain.value ? scopeImages.value.filter(entry => !references.value.has(entry.path)) : [])
function size(bytes: number) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
function select(path: string) {
  selected.value = path; dimensions.value = ''; broken.value = false
}
function loaded(event: Event) {
  const image = event.target as HTMLImageElement; dimensions.value = `${image.naturalWidth} × ${image.naturalHeight}`
}
onMounted(() => {
  void refreshMetadata()
})
async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]; input.value = ''
  if (!files.length) return
  busy.value = true; report.value = []
  const valid = files.filter((file) => {
    if (!isImage(file.name) || file.size === 0 || file.size > 50 * 1024 * 1024) {
      report.value.push(`${file.name}：请选择非空图片，单张最大 50 MB`); return false
    }; return true
  })
  try {
    const result = await uploadFolderImages(uploadDir.value, valid); report.value.push(`已处理 ${result.uploaded} 张图片，相同内容自动去重`, ...result.failures)
  } catch (error) {
    report.value.push(`上传后刷新失败，请重新检查目录：${error instanceof Error ? error.message : '网络错误'}`)
  } finally {
    busy.value = false
  }
}
async function proposeCleanup() {
  await refreshMetadata()
  if (!certain.value) {
    toast('引用状态尚未确认，不能列出清理候选'); return
  }
  cleanupCandidates.value = [...orphans.value]
  cleanupSelected.value = orphans.value.map(entry => entry.path)
}
async function clean() {
  busy.value = true; report.value = []
  try {
    const result = await cleanupImages(cleanupSelected.value)
    report.value.push(`已将 ${result.deleted.length} 张图片移入回收站`, ...result.skipped.map(item => `${item.path}：${item.reason}`))
    cleanupCandidates.value = null
  } catch (error) {
    report.value.push(`清理失败：${error instanceof Error ? error.message : '网络错误'}`)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="rm-media-library" aria-label="图片库" @keydown.esc.stop="!busy && (ws.images = null)">
    <header class="rm-media-header">
      <div><small>ASSET LIBRARY</small><h1>图片与灵感资源</h1><p>{{ ws.imagesAll ? '整个知识库' : `${dir || '根目录'} · 当前目录及直属附件` }} · {{ scopeImages.length }} 张图片 · {{ size(totalSize) }}</p></div><el-button class="rm-btn" :disabled="busy" @click="ws.images = null; ws.view = 'notes'">
        返回笔记
      </el-button>
    </header>
    <div class="rm-media-mobile-filters">
      <el-select v-model="ws.imagesAll" aria-label="资源范围">
        <el-option :value="false" label="当前目录" /><el-option :value="true" label="整个知识库" />
      </el-select><el-select v-model="usage" aria-label="引用状态">
        <el-option value="all" label="全部图片" /><el-option value="used" :disabled="!certain" label="已被引用" /><el-option value="unused" :disabled="!certain" label="未被引用" />
      </el-select><el-button class="rm-btn" :disabled="busy || !certain" @click="proposeCleanup">
        清理孤立图片
      </el-button>
    </div>
    <div class="rm-media-workspace">
      <aside class="rm-media-filters">
        <span class="rm-media-section-label">资源范围</span><button :class="{ on: !ws.imagesAll }" @click="ws.imagesAll = false">
          <Icon name="folder" />{{ dir || '根目录' }}
        </button><button :class="{ on: ws.imagesAll }" @click="ws.imagesAll = true">
          <Icon name="image" />整个知识库
        </button><span class="rm-media-section-label">引用状态</span><button v-for="item in [{ id: 'all', label: '全部图片' }, { id: 'used', label: '已被引用' }, { id: 'unused', label: '未被引用' }]" :key="item.id" :class="{ on: usage === item.id }" :disabled="item.id !== 'all' && !certain" @click="usage = item.id">
          {{ item.label }}
        </button><span class="rm-media-section-label">整理资源</span><button :disabled="busy || !certain" @click="proposeCleanup">
          <Icon name="trash" />清理孤立图片 <small>{{ orphans.length }}</small>
        </button><p>清理前核对全库引用，图片移入回收站，可恢复。</p>
      </aside>
      <div class="rm-media-content">
        <div class="rm-media-toolbar">
          <el-input v-model="query" class="rm-media-search" type="search" clearable placeholder="搜索图片名称或路径…" aria-label="搜索图片">
            <template #prefix>
              <Icon name="search" />
            </template>
          </el-input><el-select v-model="format" aria-label="图片格式">
            <el-option value="" label="所有格式" /><el-option v-for="type in types" :key="type" :value="type" :label="type.toUpperCase()" />
          </el-select><el-select v-model="sort" aria-label="图片排序">
            <el-option value="modified" label="最近修改" /><el-option value="name" label="名称" /><el-option value="size" label="文件大小" />
          </el-select><button class="rm-icon-btn" :title="list ? '切换网格' : '切换列表'" @click="list = !list">
            <Icon :name="list ? 'grid' : 'outline'" />
          </button>
        </div>
        <div class="rm-media-upload">
          <label>上传至 <el-select v-model="uploadDir" aria-label="上传目录"><el-option value="" label="根目录 / assets" /><el-option v-for="folder in directories" :key="folder.path" :value="folder.path" :label="`${folder.path} / assets`" /></el-select></label><input ref="picker" type="file" accept="image/*" multiple hidden @change="upload"><el-button class="rm-btn rm-btn-primary" :disabled="busy" @click="picker?.click()">
            <Icon name="plus" />{{ busy ? '处理中…' : '上传图片' }}
          </el-button>
        </div>
        <p v-if="metadata.error || !certain" class="rm-media-warning" role="status">
          {{ metadata.error || (metadata.ready ? '部分笔记元数据异常，引用状态不完整；已禁用清理。' : '正在读取引用索引…') }} <el-button class="rm-btn" @click="refreshMetadata()">
            刷新状态
          </el-button>
        </p>
        <div v-if="report.length" class="rm-media-report" role="status">
          <p v-for="(line, i) in report" :key="i">
            {{ line }}
          </p>
        </div>
        <div class="rm-media-grid" :class="{ list }">
          <button v-for="image in images" :key="image.path" class="rm-media-card" :class="{ selected: selected === image.path }" :title="image.path" @click="select(image.path)" @dblclick="ws.image = image.path" @contextmenu.prevent="ws.image = image.path">
            <span class="rm-media-thumbnail"><img :src="imageUrl(image.path)" :alt="basename(image.path)" loading="lazy"></span><strong>{{ basename(image.path) }}</strong><small>{{ size(image.size) }} · {{ certain ? `${references.get(image.path)?.length ?? 0} 篇引用` : '引用未确认' }}</small>
          </button>
        </div>
        <p v-if="!images.length" class="rm-tree-empty">
          没有符合条件的图片
        </p>
      </div>
      <aside v-if="current" class="rm-media-inspector">
        <button class="rm-icon-btn rm-media-deselect" title="关闭详情" @click="selected = ''">
          <Icon name="close" />
        </button><div class="rm-media-detail-image">
          <img v-if="!broken" :src="imageUrl(current.path)" :alt="basename(current.path)" @load="loaded" @error="broken = true"><p v-else>
            无法预览此图片
          </p>
        </div><h2>{{ basename(current.path) }}</h2><p class="rm-media-path">
          {{ current.path }}
        </p><dl><dt>尺寸</dt><dd>{{ dimensions || (broken ? '无法读取' : '加载中…') }}</dd><dt>大小</dt><dd>{{ size(current.size) }}</dd><dt>修改时间</dt><dd>{{ new Date(current.mtime).toLocaleDateString('zh-CN') }}</dd><dt>引用</dt><dd>{{ certain ? `${currentRefs.length} 篇笔记` : '尚未确认' }}</dd></dl><el-button class="rm-btn rm-btn-primary" @click="ws.image = current.path">
          <Icon name="edit" />预览与编辑
        </el-button><h3>引用此图片的笔记</h3><button v-for="reference in currentRefs" :key="reference.path" class="rm-media-reference" @click="ws.images = null; openReference(reference.path, reference.line)">
          <Icon name="note" /><span>{{ reference.title }}<small>{{ reference.path }}</small></span>
        </button><p v-if="certain && !currentRefs.length">
          没有笔记引用
        </p>
      </aside>
    </div>
    <el-dialog :model-value="cleanupCandidates !== null" :title="`清理候选 · ${cleanupCandidates?.length ?? 0} 张`" width="640px" class="rm-cleanup-dialog" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" :before-close="() => { if (!busy) cleanupCandidates = null }" @close="cleanupCandidates = null">
      <p class="rm-share-note">
        服务端会再次读取最新笔记；仍有引用的图片将跳过。确认后移入回收站。
      </p><ul>
        <li v-for="image in cleanupCandidates ?? []" :key="image.path">
          <el-checkbox-group v-model="cleanupSelected">
            <el-checkbox :value="image.path" :disabled="busy">
              {{ image.path }} <small>{{ size(image.size) }}</small>
            </el-checkbox>
          </el-checkbox-group>
        </li>
      </ul><p v-if="!cleanupCandidates?.length" class="rm-share-note">
        当前范围没有可清理的孤立图片。
      </p><div class="rm-cleanup-actions">
        <el-button class="rm-btn" :disabled="busy" @click="cleanupCandidates = null">
          取消
        </el-button><el-button class="rm-btn rm-btn-primary" :disabled="busy || !cleanupSelected.length" @click="clean">
          移入回收站（{{ cleanupSelected.length }}）
        </el-button>
      </div>
    </el-dialog>
  </section>
</template>

<style scoped lang="scss">
.rm-media-toolbar :deep(.el-select) {
  width: 130px;
}
.rm-media-upload :deep(.el-select) {
  width: 240px;
  max-width: 100%;
}
.rm-media-mobile-filters :deep(.el-select) {
  width: 130px;
}
.rm-media-search.el-input {
  padding: 0;
  border: 0;
}
:deep(.el-checkbox) {
  height: auto;
  white-space: normal;
}
:deep(.el-checkbox__label) {
  overflow-wrap: anywhere;
}
.rm-media-library {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  padding: var(--rm-space-6);
  overflow: hidden;
}
.rm-media-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  padding: 0 0 24px;
  gap: 12px;
}
.rm-media-header small {
  font-size: var(--rm-ui-font-caption);
  color: var(--rm-accent);
  letter-spacing: 0.14em;
}
h1 {
  font: 600 var(--rm-ui-font-title)/var(--rm-ui-line-height) var(--rm-font-text);
  margin: var(--rm-space-2) 0;
}
p {
  font-size: var(--rm-ui-font-small);
  color: var(--rm-text-muted);
  line-height: 1.7;
  margin: 6px 0;
}
.rm-media-workspace {
  display: flex;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--rm-divider);
  border-radius: 16px;
  overflow: hidden;
  background: color-mix(in srgb, var(--rm-bg) calc(var(--rm-glass-opacity) * 100%), transparent);
}
.rm-media-filters {
  flex: none;
  width: 190px;
  padding: var(--rm-space-4) var(--rm-space-2);
  border-right: 1px solid var(--rm-divider);
  background: var(--rm-sidebar-bg);
  overflow: auto;
}
.rm-media-section-label {
  display: block;
  margin: 12px 8px;
  font-size: var(--rm-ui-font-caption);
  color: var(--rm-text-muted);
}
.rm-media-filters button {
  overflow-wrap: anywhere;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: var(--rm-space-2);
  min-height: var(--rm-control-size);
  margin: 4px 0;
  background: none;
  border: 0;
  border-radius: 7px;
  font-size: var(--rm-ui-font-size);
  text-align: left;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.rm-media-filters button.on {
  background: var(--rm-active);
  color: var(--rm-accent);
}
.rm-media-filters p {
  font-size: var(--rm-ui-font-caption);
  padding: 8px;
}
.rm-media-content {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: var(--rm-space-4);
}
.rm-media-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rm-media-search {
  box-sizing: border-box;
  min-height: var(--rm-control-size);
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 130px;
  padding: 8px 10px;
  border: 1px solid var(--rm-divider);
  border-radius: 8px;
}
.rm-media-search input {
  width: 100%;
  min-width: 0;
  background: none;
  color: var(--rm-text);
  border: 0;
  outline: none;
  font: var(--rm-ui-font-size) var(--rm-font-text);
}
select {
  min-height: var(--rm-control-size);
  max-width: 100%;
  padding: 8px;
  border: 1px solid var(--rm-divider);
  border-radius: 7px;
  background: var(--rm-bg);
  color: var(--rm-text);
  font: var(--rm-ui-font-size) var(--rm-font-text);
}
.rm-media-upload {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
  margin: 16px 0;
}
.rm-media-upload label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: var(--rm-ui-font-size);
}
.rm-media-upload label select {
  min-height: var(--rm-control-size);
  max-width: 100%;
  min-width: 0;
  flex: 1;
}
.rm-media-upload .rm-btn {
  font-size: var(--rm-ui-font-size);
}
.rm-media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(145px, 1fr));
  gap: 16px;
  padding: 8px 0;
}
.rm-media-card {
  display: flex;
  flex-direction: column;
  gap: 9px;
  border: 1px solid var(--rm-divider);
  border-radius: 12px;
  padding: 10px;
  background: var(--rm-active);
  text-align: left;
  min-width: 0;
  cursor: pointer;
}
.rm-media-card:hover,
.rm-media-card.selected {
  border-color: var(--rm-accent);
  box-shadow: 0 3px 12px var(--rm-selection);
}
.rm-media-thumbnail {
  display: grid;
  place-items: center;
  height: 130px;
  width: 100%;
  border-radius: 7px;
  overflow: hidden;
  background: var(--rm-sidebar-bg);
}
.rm-media-thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.rm-media-card strong {
  max-width: 100%;
  font-size: var(--rm-ui-font-size);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rm-media-card small {
  font-size: var(--rm-ui-font-caption);
  color: var(--rm-text-muted);
}
.rm-media-grid.list {
  grid-template-columns: 1fr;
  gap: 6px;
}
.list .rm-media-card {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.list .rm-media-thumbnail {
  width: 54px;
  height: 42px;
  flex: none;
}
.list .rm-media-card small {
  margin-left: auto;
  white-space: nowrap;
}
.rm-media-inspector {
  flex: none;
  width: 230px;
  padding: var(--rm-space-4);
  border-left: 1px solid var(--rm-divider);
  overflow: auto;
}
.rm-media-deselect {
  margin-left: auto;
  display: flex;
}
.rm-media-detail-image {
  height: 145px;
  border-radius: 8px;
  background: var(--rm-sidebar-bg);
  display: grid;
  place-items: center;
  overflow: hidden;
  margin: 12px 0;
}
.rm-media-detail-image img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
h2 {
  font-size: var(--rm-ui-font-size);
  overflow-wrap: anywhere;
}
.rm-media-path {
  font-size: var(--rm-ui-font-caption);
  overflow-wrap: anywhere;
}
dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 12px;
  font-size: var(--rm-ui-font-caption);
  margin: 20px 0;
}
dt {
  color: var(--rm-text-muted);
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.rm-media-inspector > .rm-btn {
  width: 100%;
  justify-content: center;
}
h3 {
  font-size: var(--rm-ui-font-size);
  border-top: 1px solid var(--rm-divider);
  margin-top: 24px;
  padding-top: 20px;
}
.rm-media-reference {
  overflow-wrap: anywhere;
  display: flex;
  gap: 8px;
  text-align: left;
  background: none;
  border: 0;
  padding: 10px 0;
  width: 100%;
  cursor: pointer;
  font-size: var(--rm-ui-font-size);
}
.rm-media-reference small {
  display: block;
  color: var(--rm-text-muted);
  font-size: var(--rm-ui-font-caption);
  margin-top: 5px;
  overflow-wrap: anywhere;
}
.rm-media-warning,
.rm-media-report {
  padding: 12px;
  border-radius: 8px;
  background: var(--rm-warn-bg);
  color: var(--rm-warn-text);
  font-size: var(--rm-ui-font-small);
}
.rm-media-warning .rm-btn {
  font-size: var(--rm-ui-font-size);
  margin-left: 8px;
}
.rm-media-report p {
  color: inherit;
  overflow-wrap: anywhere;
}
.rm-cleanup-dialog {
  width: min(640px, calc(100vw - 24px));
}
.rm-cleanup-dialog ul {
  list-style: none;
  overflow: auto;
  padding: 12px 20px;
  margin: 0;
}
.rm-cleanup-dialog li {
  padding: 10px 0;
  font-size: var(--rm-ui-font-small);
  overflow-wrap: anywhere;
}
.rm-cleanup-dialog label {
  display: flex;
  gap: 10px;
}
.rm-cleanup-dialog small {
  margin-left: auto;
  color: var(--rm-text-muted);
  white-space: nowrap;
}
.rm-cleanup-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: var(--rm-space-4);
}
.rm-media-mobile-filters {
  display: none;
}
@media (max-width: 1199px) {
  .rm-media-library {
    padding: var(--rm-space-4);
  }
  .rm-media-filters {
    width: 180px;
    padding: 12px 8px;
  }
  .rm-media-inspector {
    width: 180px;
    padding: var(--rm-space-4);
  }
}
@media (max-width: 767px) {
  .rm-media-mobile-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 12px;
  }
  .rm-media-mobile-filters .rm-btn {
    font-size: var(--rm-ui-font-size);
  }
  .rm-media-library {
    padding: var(--rm-space-4);
  }
  h1 {
    font-size: var(--rm-ui-font-heading);
  }
  .rm-media-header {
    padding-bottom: 16px;
  }
  .rm-media-filters {
    display: none;
  }
  .rm-media-content {
    padding: 12px;
  }
  .rm-media-toolbar {
    gap: 6px;
  }
  .rm-media-inspector {
    position: absolute;
    inset: 0;
    z-index: 20;
    background: var(--rm-bg);
    width: auto;
    padding: var(--rm-space-4);
  }
  .rm-media-workspace {
    position: relative;
  }
  .rm-media-search {
    flex-basis: 100%;
  }
  .rm-media-grid {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px;
  }
  .rm-media-upload {
    flex-wrap: wrap;
  }
  .rm-media-upload label {
    flex: 1;
  }
  .rm-media-upload select {
    min-height: var(--rm-control-size);
    max-width: 180px;
  }
}
@media (max-width: 767px), (pointer: coarse) {
  input[type='search'],
  select {
    font-size: max(16px, var(--rm-ui-font-size));
  }
}
</style>
