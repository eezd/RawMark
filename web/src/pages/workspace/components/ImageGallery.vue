<script setup lang="ts">
import type { Entry } from '@@/apis/tree/type'

import Icon from '@@/components/Icon/index.vue'
import { locale, t as translate } from '@@/i18n/runtime'
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
}).sort((a, b) => sort.value === 'name' ? a.path.localeCompare(b.path, locale.value, { numeric: true }) : sort.value === 'size' ? b.size - a.size : b.mtime - a.mtime))
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
      report.value.push(translate('workspace.choose_a_non_empty_image_c3cdc3', { p0: file.name })); return false
    }; return true
  })
  try {
    const result = await uploadFolderImages(uploadDir.value, valid); report.value.push(translate('workspace.processed_images_identical_content_is_9c3f9a', { p0: result.uploaded }), ...result.failures)
  } catch (error) {
    report.value.push(translate('workspace.upload_complete_but_refresh_failed_a8fdfb', { p0: error instanceof Error ? error.message : translate('common.network_error') }))
  } finally {
    busy.value = false
  }
}
async function proposeCleanup() {
  await refreshMetadata()
  if (!certain.value) {
    toast(translate('workspace.references_are_not_confirmed_cleanup_76caea')); return
  }
  cleanupCandidates.value = [...orphans.value]
  cleanupSelected.value = orphans.value.map(entry => entry.path)
}
async function clean() {
  busy.value = true; report.value = []
  try {
    const result = await cleanupImages(cleanupSelected.value)
    report.value.push(translate('workspace.moved_images_to_trash_c5b457', { count: result.deleted.length }), ...result.skipped.map(item => `${item.path}：${item.reason}`))
    cleanupCandidates.value = null
  } catch (error) {
    report.value.push(translate('workspace.cleanup_failed_86823d', { p0: error instanceof Error ? error.message : translate('common.network_error') }))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="rm-media-library" :aria-label="translate('workspace.image_library_92329a')" @keydown.esc.stop="!busy && (ws.images = null)">
    <header class="rm-media-header">
      <div><small>ASSET LIBRARY</small><h1>{{ translate('workspace.images_and_visual_resources_794f97') }}</h1><p>{{ ws.imagesAll ? translate('workspace.entire_vault_a8e1f0') : translate('workspace.current_folder_and_direct_attachments_c2a863', { p0: dir || translate('workspace.root_folder_42ee28') }) }} · {{ scopeImages.length }} {{ translate('workspace.images_b62646') }} {{ size(totalSize) }}</p></div><el-button class="rm-btn" :disabled="busy" @click="ws.images = null; ws.view = 'notes'">
        {{ translate('workspace.back_to_notes_38461a') }}
      </el-button>
    </header>
    <div class="rm-media-mobile-filters">
      <el-select v-model="ws.imagesAll" :aria-label="translate('workspace.resource_scope_9c55b5')">
        <el-option :value="false" :label="translate('workspace.current_folder_257f44')" /><el-option :value="true" :label="translate('workspace.entire_vault_a8e1f0')" />
      </el-select><el-select v-model="usage" :aria-label="translate('workspace.references_92fb1e')">
        <el-option value="all" :label="translate('workspace.all_images_048d65')" /><el-option value="used" :disabled="!certain" :label="translate('workspace.referenced_981f27')" /><el-option value="unused" :disabled="!certain" :label="translate('workspace.unreferenced_01e3bd')" />
      </el-select><el-button class="rm-btn" :disabled="busy || !certain" @click="proposeCleanup">
        {{ translate('workspace.clean_unused_images_f4eb11') }}
      </el-button>
    </div>
    <div class="rm-media-workspace">
      <aside class="rm-media-filters">
        <span class="rm-media-section-label">{{ translate('workspace.resource_scope_9c55b5') }}</span><button :class="{ on: !ws.imagesAll }" @click="ws.imagesAll = false">
          <Icon name="folder" />{{ dir || translate('workspace.root_folder_42ee28') }}
        </button><button :class="{ on: ws.imagesAll }" @click="ws.imagesAll = true">
          <Icon name="image" />{{ translate('workspace.entire_vault_a8e1f0') }}
        </button><span class="rm-media-section-label">{{ translate('workspace.references_92fb1e') }}</span><button v-for="item in [{ id: 'all', get label() { return translate('workspace.all_images_048d65') } }, { id: 'used', get label() { return translate('workspace.referenced_981f27') } }, { id: 'unused', get label() { return translate('workspace.unreferenced_01e3bd') } }]" :key="item.id" :class="{ on: usage === item.id }" :disabled="item.id !== 'all' && !certain" @click="usage = item.id">
          {{ item.label }}
        </button><span class="rm-media-section-label">{{ translate('workspace.organize_resources_ecf902') }}</span><button :disabled="busy || !certain" @click="proposeCleanup">
          <Icon name="trash" />{{ translate('workspace.clean_unused_images_f4eb11') }} <small>{{ orphans.length }}</small>
        </button><p>{{ translate('workspace.checks_references_across_the_vault_371581') }}</p>
      </aside>
      <div class="rm-media-content">
        <div class="rm-media-toolbar">
          <el-input v-model="query" class="rm-media-search" type="search" clearable :placeholder="translate('workspace.search_image_names_or_paths_944196')" :aria-label="translate('workspace.search_images_8f938f')">
            <template #prefix>
              <Icon name="search" />
            </template>
          </el-input><el-select v-model="format" :aria-label="translate('workspace.image_format_f2ed45')">
            <el-option value="" :label="translate('workspace.all_formats_c8b740')" /><el-option v-for="type in types" :key="type" :value="type" :label="type.toUpperCase()" />
          </el-select><el-select v-model="sort" :aria-label="translate('workspace.image_sort_order_34877a')">
            <el-option value="modified" :label="translate('workspace.last_modified_ad3bf1')" /><el-option value="name" :label="translate('common.name_d44e9b')" /><el-option value="size" :label="translate('workspace.file_size_b9bf69')" />
          </el-select><button class="rm-icon-btn" :title="list ? translate('workspace.grid_view_709ce2') : translate('workspace.list_view_383611')" @click="list = !list">
            <Icon :name="list ? 'grid' : 'outline'" />
          </button>
        </div>
        <div class="rm-media-upload">
          <label>{{ translate('workspace.upload_to_46873e') }} <el-select v-model="uploadDir" :aria-label="translate('workspace.upload_folder_462e85')"><el-option value="" :label="translate('workspace.root_assets_c9d759')" /><el-option v-for="folder in directories" :key="folder.path" :value="folder.path" :label="`${folder.path} / assets`" /></el-select></label><input ref="picker" type="file" accept="image/*" multiple hidden @change="upload"><el-button class="rm-btn rm-btn-primary" :disabled="busy" @click="picker?.click()">
            <Icon name="plus" />{{ busy ? translate('workspace.processing_d3d211') : translate('workspace.upload_images_9fbb47') }}
          </el-button>
        </div>
        <p v-if="metadata.error || !certain" class="rm-media-warning" role="status">
          {{ metadata.error || (metadata.ready ? translate('workspace.some_note_metadata_is_invalid_26b8ec') : translate('workspace.reading_reference_index_8392a7')) }} <el-button class="rm-btn" @click="refreshMetadata()">
            {{ translate('workspace.refresh_status_802a40') }}
          </el-button>
        </p>
        <div v-if="report.length" class="rm-media-report" role="status">
          <p v-for="(line, i) in report" :key="i">
            {{ line }}
          </p>
        </div>
        <div class="rm-media-grid" :class="{ list }">
          <button v-for="image in images" :key="image.path" class="rm-media-card" :class="{ selected: selected === image.path }" :title="image.path" @click="select(image.path)" @dblclick="ws.image = image.path" @contextmenu.prevent="ws.image = image.path">
            <span class="rm-media-thumbnail"><img :src="imageUrl(image.path)" :alt="basename(image.path)" loading="lazy"></span><strong>{{ basename(image.path) }}</strong><small>{{ size(image.size) }} · {{ certain ? translate('workspace.references_9aa726', { count: references.get(image.path)?.length ?? 0 }) : translate('workspace.references_not_confirmed_5abb9b') }}</small>
          </button>
        </div>
        <p v-if="!images.length" class="rm-tree-empty">
          {{ translate('workspace.no_matching_images_129380') }}
        </p>
      </div>
      <aside v-if="current" class="rm-media-inspector">
        <button class="rm-icon-btn rm-media-deselect" :title="translate('workspace.close_details_9071cf')" @click="selected = ''">
          <Icon name="close" />
        </button><div class="rm-media-detail-image">
          <img v-if="!broken" :src="imageUrl(current.path)" :alt="basename(current.path)" @load="loaded" @error="broken = true"><p v-else>
            {{ translate('workspace.cannot_preview_this_image_99dab9') }}
          </p>
        </div><h2>{{ basename(current.path) }}</h2><p class="rm-media-path">
          {{ current.path }}
        </p><dl><dt>{{ translate('workspace.dimensions_246df7') }}</dt><dd>{{ dimensions || (broken ? translate('workspace.cannot_read_c27041') : translate('workspace.loading_4927a5')) }}</dd><dt>{{ translate('workspace.size_50db74') }}</dt><dd>{{ size(current.size) }}</dd><dt>{{ translate('workspace.modified_257bbc') }}</dt><dd>{{ new Date(current.mtime).toLocaleDateString(locale) }}</dd><dt>{{ translate('workspace.references_e0ec65') }}</dt><dd>{{ certain ? translate('workspace.notes_fd9460', { count: currentRefs.length }) : translate('workspace.not_confirmed_10e9fc') }}</dd></dl><el-button class="rm-btn rm-btn-primary" @click="ws.image = current.path">
          <Icon name="edit" />{{ translate('workspace.preview_and_edit_d797af') }}
        </el-button><h3>{{ translate('workspace.notes_referencing_this_image_b2a9ac') }}</h3><button v-for="reference in currentRefs" :key="reference.path" class="rm-media-reference" @click="ws.images = null; openReference(reference.path, reference.line)">
          <Icon name="note" /><span>{{ reference.title }}<small>{{ reference.path }}</small></span>
        </button><p v-if="certain && !currentRefs.length">
          {{ translate('workspace.no_notes_reference_this_image_aab134') }}
        </p>
      </aside>
    </div>
    <el-dialog :model-value="cleanupCandidates !== null" :title="translate('workspace.cleanup_candidates_images_9cd82b', { count: cleanupCandidates?.length ?? 0 })" width="640px" class="rm-cleanup-dialog" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" :before-close="() => { if (!busy) cleanupCandidates = null }" @close="cleanupCandidates = null">
      <p class="rm-share-note">
        {{ translate('workspace.the_server_will_check_the_cce22a') }}
      </p><ul>
        <li v-for="image in cleanupCandidates ?? []" :key="image.path">
          <el-checkbox-group v-model="cleanupSelected">
            <el-checkbox :value="image.path" :disabled="busy">
              {{ image.path }} <small>{{ size(image.size) }}</small>
            </el-checkbox>
          </el-checkbox-group>
        </li>
      </ul><p v-if="!cleanupCandidates?.length" class="rm-share-note">
        {{ translate('workspace.no_unused_images_to_clean_ad136a') }}
      </p><div class="rm-cleanup-actions">
        <el-button class="rm-btn" :disabled="busy" @click="cleanupCandidates = null">
          {{ translate('common.cancel_2cd0f3') }}
        </el-button><el-button class="rm-btn rm-btn-primary" :disabled="busy || !cleanupSelected.length" @click="clean">
          {{ translate('workspace.move_to_trash_911c22') }}{{ cleanupSelected.length }}）
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
