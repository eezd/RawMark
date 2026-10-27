<script setup lang="ts">
import type { SettingSearchResult } from './settings-catalog'

import type { SettingsSection } from '@/pinia/stores/settings'
import Icon from '@@/components/Icon/index.vue'
import { t as translate } from '@@/i18n/runtime'
import { runCommand } from '@@/utils/commands'
import { installApp, installPrompt } from '@@/utils/pwa'
import { computed, nextTick, ref } from 'vue'
import { useSettingsStore } from '@/pinia/stores/settings'
import AccountSettings from './components/AccountSettings.vue'
import EditorSettings from './components/EditorSettings.vue'
import InterfaceSettings from './components/InterfaceSettings.vue'
import PluginsPanel from './components/PluginsPanel.vue'
import SettingRow from './components/SettingRow.vue'
import ShortcutSettings from './components/ShortcutSettings.vue'
import StoragePanel from './components/StoragePanel.vue'
import TrashPanel from './components/TrashPanel.vue'
import { searchSettings, SETTINGS_SECTIONS } from './settings-catalog'

const props = defineProps<{ prepareMaintenance: () => Promise<void>, restoreNote: (id: string) => Promise<void> }>()
const emit = defineEmits<{ importNotes: [] }>()
const { settingsSave } = useSettingsStore()
const releaseVersion = __RAWMARK_RELEASE__
const buildVersion = import.meta.env.DEV ? translate('settings.development_0d1c11') : document.querySelector<HTMLMetaElement>('meta[name="rawmark-version"]')?.content
if (!buildVersion) throw new Error(translate('settings.application_build_information_is_missing_6b04f9'))
const model = defineModel<SettingsSection | 'index' | null>({ required: true })
const section = computed(() => model.value === 'index' || model.value === null ? 'appearance' : model.value)
const showList = ref(model.value === 'index')
const current = computed(() => SETTINGS_SECTIONS.find(s => s.id === section.value)!)
const query = ref('')
const searching = computed(() => !!query.value.trim())
const results = computed(() => searchSettings(query.value))
const content = ref<HTMLElement>()
const heading = ref<HTMLElement>()
const preferenceSection = computed(() => ['appearance', 'editor', 'shortcuts', 'trash'].includes(section.value))
const saveLabel = computed(() => settingsSave.pending ? translate('settings.saving_ff509c') : settingsSave.result === 'error' ? translate('settings.save_failed_6309a3') : settingsSave.result === 'saved' ? translate('settings.saved_1bd91a') : translate('settings.changes_save_automatically_b88990'))
async function open(id: SettingsSection) {
  query.value = ''; model.value = id; showList.value = false
  await nextTick()
  content.value!.scrollTop = 0
  heading.value!.focus({ preventScroll: true })
}
async function locate(result: SettingSearchResult) {
  await open(result.section)
  if (!result.id) return
  const target = document.getElementById(`rm-setting-${result.id}`)!
  for (let parent = target.parentElement; parent && parent !== content.value; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true
  }
  if (target instanceof HTMLDetailsElement) target.open = true
  await nextTick()
  target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'center' })
}
function back() {
  query.value = ''; showList.value = true
}
function close() {
  model.value = null
}
</script>

<template>
  <el-dialog :model-value="model !== null" class="rm-settings-modal" :title="translate('common.settings_df3d58')" :show-close="false" :close-on-click-modal="true" align-center destroy-on-close @close="close">
    <div class="rm-settings" :class="{ 'show-list': showList, searching }">
      <nav class="rm-settings-nav" :aria-label="translate('settings.settings_categories_dfb699')">
        <div class="rm-dialog-head">
          <h2>{{ translate('common.settings_df3d58') }}</h2>
          <button class="rm-icon-btn rm-settings-close-list" :title="translate('settings.close_settings_77b17f')" @click="close">
            <Icon name="close" />
          </button>
        </div>
        <el-input v-model="query" class="rm-settings-search" type="search" clearable :aria-label="translate('settings.search_settings_287415')" :placeholder="translate('settings.search_settings_287415')">
          <template #prefix>
            <Icon name="search" />
          </template>
        </el-input>
        <div class="rm-settings-categories">
          <button v-for="s in SETTINGS_SECTIONS" :key="s.id" class="rm-settings-tab" :class="{ on: s.id === section && !searching }" :aria-current="s.id === section && !searching ? 'page' : undefined" @click="open(s.id)">
            <Icon :name="s.icon" />{{ s.title }}
          </button>
        </div>
        <div class="rm-settings-nav-foot">
          <span>RawMark</span><small>{{ releaseVersion }}</small>
        </div>
      </nav>
      <section class="rm-settings-body">
        <div class="rm-dialog-head">
          <button class="rm-icon-btn rm-settings-back" :title="translate('settings.back_to_settings_categories_2b3f9b')" @click="back">
            <Icon name="chevron" class="flip" />
          </button>
          <h2 ref="heading" tabindex="-1">
            {{ searching ? translate('common.search_results_88d72e') : current.title }}
          </h2>
          <span v-if="preferenceSection && !searching" class="rm-settings-save" :class="{ error: settingsSave.result === 'error' && !settingsSave.pending }" :title="settingsSave.error || translate('settings.preferences_are_saved_on_the_adf9bd')" role="status" aria-live="polite">{{ saveLabel }}</span>
          <button class="rm-icon-btn" :title="translate('settings.close_settings_77b17f')" @click="close">
            <Icon name="close" />
          </button>
        </div>
        <div ref="content" class="rm-settings-content">
          <div v-if="searching" class="rm-settings-results">
            <p class="rm-settings-result-count" role="status">
              {{ results.length ? translate('settings.found_settings_24ca43', { count: results.length }) : translate('settings.no_matching_settings_try_different_3747bc') }}
            </p>
            <button v-for="result in results" :key="result.id || result.section" class="rm-settings-result" @click="locate(result)">
              <span><strong>{{ result.title }}</strong><small>{{ result.description }}</small></span><small>{{ SETTINGS_SECTIONS.find(s => s.id === result.section)!.title }}</small><Icon name="chevron" />
            </button>
          </div>
          <div v-show="!searching" class="rm-settings-page">
            <PluginsPanel v-if="section === 'plugins'" />
            <InterfaceSettings v-else-if="section === 'appearance'" />
            <EditorSettings v-else-if="section === 'editor'" />
            <AccountSettings v-else-if="section === 'account'" @logout="close(), runCommand('app.logout')" />

            <ShortcutSettings v-else-if="section === 'shortcuts'" />

            <TrashPanel v-else-if="section === 'trash'" :restore-note="props.restoreNote" />
            <StoragePanel v-else-if="section === 'storage'" :prepare-maintenance="props.prepareMaintenance" @import-notes="emit('importNotes')" />
            <template v-else-if="section === 'about'">
              <p class="rm-share-note">
                {{ translate('settings.rawmark_a_markdown_note_editor_66b52a') }}
              </p>
              <SettingRow id="version">
                <code>{{ releaseVersion }} · {{ buildVersion }}</code>
              </SettingRow>
              <SettingRow id="install">
                <el-button v-if="installPrompt" class="rm-btn" @click="installApp">
                  {{ translate('settings.install_rawmark_8ccabe') }}
                </el-button><span v-else class="rm-settings-unavailable">{{ translate('settings.this_browser_does_not_currently_d6d77a') }}</span>
              </SettingRow>
              <SettingRow id="openapi">
                <a class="rm-btn" href="/api/v1/openapi.json" target="_blank" rel="noopener">{{ translate('settings.view_openapi_documentation_4f11fd') }}</a>
              </SettingRow>
            </template>
          </div>
        </div>
      </section>
    </div>
  </el-dialog>
</template>

<style scoped lang="scss">
.rm-settings {
  box-sizing: border-box;
  display: flex;
  flex-direction: row;
  width: 100%;
  max-width: 960px;
  height: min(720px, 82dvh);
  max-height: 100%;
  overflow: hidden;
  border: 1px solid var(--rm-divider);
  background: color-mix(in srgb, var(--rm-bg) calc(var(--rm-glass-opacity) * 100%), transparent);
  backdrop-filter: blur(20px);
  outline: none;
}
.rm-settings-nav {
  box-sizing: border-box;
  flex: none;
  width: 192px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--rm-divider);
  background: color-mix(in srgb, var(--rm-sidebar-bg) 70%, transparent);
}
.rm-settings :deep(.rm-dialog-head) {
  flex: none;
  box-sizing: border-box;
  min-height: 52px;
  gap: 8px;
  padding: 8px 16px;
}
.rm-settings :deep(.rm-dialog-head h2) {
  font-size: var(--rm-ui-font-size);
  font-weight: 600;
  min-width: 0;
  outline: none;
}
.rm-settings-close-list,
.rm-settings-back {
  display: none;
}
.rm-settings-search {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  min-height: var(--rm-control-size);
  margin: 0 8px 8px;
  padding: 0 6px;
  border: 1px solid var(--rm-divider);
  border-radius: 6px;
  background: var(--rm-bg);
}
.rm-settings-search > .rm-icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--rm-text-muted);
}
.rm-settings-search input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: var(--rm-control-size);
  padding: 4px 0;
  border: 0;
  outline: 0;
  background: none;
  color: var(--rm-text);
  font: inherit;
}
.rm-settings-search input::-webkit-search-cancel-button {
  display: none;
}
.rm-settings-search:focus-within {
  border-color: var(--rm-accent);
}
.rm-settings-categories {
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 8px;
}
.rm-settings-tab {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: var(--rm-control-size);
  margin: 2px 0;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--rm-text-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.rm-settings-tab .rm-icon {
  flex: none;
}
.rm-settings-tab:hover {
  background: var(--rm-hover);
}
.rm-settings-tab.on {
  background: var(--rm-active);
  color: var(--rm-accent-strong);
}
.rm-settings-nav-foot {
  margin-top: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--rm-ui-font-small);
  color: var(--rm-text-muted);
}
.rm-settings-nav-foot small {
  font-size: inherit;
  overflow-wrap: anywhere;
}
.rm-settings-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.rm-settings-body > .rm-dialog-head {
  border-bottom: 1px solid var(--rm-divider);
}
.rm-settings-save {
  flex: none;
  font-size: var(--rm-ui-font-small);
  color: var(--rm-text-muted);
}
.rm-settings-save.error {
  color: var(--rm-danger);
}
.rm-settings-content {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  padding: 0 24px 16px;
}
.rm-settings-page {
  min-width: 0;
}
.rm-settings :deep(.rm-setting) {
  flex-wrap: wrap;
  gap: 12px 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--rm-divider);
  font-size: var(--rm-ui-font-size);
}
:deep(.rm-setting-info) {
  flex: 1 1 180px;
  min-width: 0;
}
:deep(.rm-setting-info p) {
  margin: 4px 0 0;
  color: var(--rm-text-muted);
  font-size: var(--rm-ui-font-small);
  line-height: var(--rm-ui-line-height);
  overflow-wrap: anywhere;
}
:deep(.rm-setting-control) {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
  margin-left: auto;
}
:deep(.rm-setting-control output) {
  min-width: 42px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
:deep(.rm-setting-control code) {
  overflow-wrap: anywhere;
}
:deep(.rm-setting-reset) {
  flex: none;
  color: var(--rm-text-muted);
}
:deep(.rm-settings-group-title) {
  margin: 20px 0 0;
  font-size: var(--rm-ui-font-size);
  font-weight: 600;
  color: var(--rm-text-muted);
}
:deep(.rm-settings-group-title:first-child) {
  margin-top: 16px;
}
:deep(.rm-settings-details) {
  margin: 12px 0;
}
:deep(.rm-settings-details > summary) {
  padding: 8px 0;
  min-height: var(--rm-control-size);
  box-sizing: border-box;
  cursor: pointer;
  font-size: var(--rm-ui-font-size);
  color: var(--rm-text-muted);
}
:deep(.rm-typography-preview) {
  margin: 8px 0 0;
  padding: 16px;
  border: 1px solid var(--rm-divider);
  border-radius: 8px;
  background: var(--rm-sidebar-bg);
  font: var(--rm-font-size)/var(--rm-line-height) var(--rm-font-editor, var(--rm-font-text));
  overflow-wrap: anywhere;
}
:deep(.rm-typography-preview h2) {
  margin-top: 0;
  font-family: var(--rm-font-heading);
  font-size: 1.5em;
}
:deep(.rm-typography-preview p) {
  margin: 0;
}
:deep(.rm-typography-preview p + p) {
  margin-top: 1lh;
}
:deep(.rm-typography-preview code) {
  font-family: var(--rm-font-mono);
  font-size: 0.9em;
  color: var(--rm-inline-code-text);
}
.rm-settings :deep(.rm-share-note),
.rm-settings :deep(.rm-appearance-note) {
  margin: 12px 0;
  overflow-wrap: anywhere;
}
.rm-settings :deep(.rm-token-created) {
  margin: 12px 0;
}
.rm-settings :deep(.rm-snippet-form) {
  padding: 12px 0;
}
.rm-settings :deep(.rm-plugin-view) {
  padding: 12px 0;
}
.rm-settings-unavailable {
  max-width: 240px;
  font-size: var(--rm-ui-font-small);
  color: var(--rm-text-muted);
}
.rm-settings-result-count {
  margin: 12px 0;
  font-size: var(--rm-ui-font-small);
  color: var(--rm-text-muted);
}
.rm-settings-result {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 0;
  border: 0;
  border-bottom: 1px solid var(--rm-divider);
  background: none;
  color: var(--rm-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.rm-settings-result:hover {
  background: var(--rm-hover);
}
.rm-settings-result > span {
  flex: 1;
  min-width: 0;
}
.rm-settings-result strong {
  font-weight: 500;
}
.rm-settings-result small {
  display: block;
  margin-top: 4px;
  font-size: var(--rm-ui-font-small);
  color: var(--rm-text-muted);
  overflow-wrap: anywhere;
}
.rm-settings-result > .rm-icon {
  flex: none;
  color: var(--rm-text-muted);
}

@media (max-width: 767px) {
  .rm-settings {
    height: 100dvh;
    max-width: none;
    border: 0;
    border-radius: 0;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--rm-bg);
  }
  .rm-settings-nav {
    display: none;
    width: 100%;
    border-right: 0;
  }
  .rm-settings.show-list .rm-settings-nav {
    display: flex;
  }
  .rm-settings.show-list .rm-settings-body {
    display: none;
  }
  .rm-settings.show-list.searching {
    flex-direction: column;
  }
  .rm-settings.show-list.searching .rm-settings-body {
    display: flex;
  }
  .rm-settings.show-list.searching
    :is(.rm-settings-categories, .rm-settings-nav-foot, .rm-settings-body > .rm-dialog-head) {
    display: none;
  }
  .rm-settings.show-list:not(.searching) .rm-settings-nav {
    flex: 1;
  }
  .rm-settings :deep(.rm-dialog-head) {
    padding: 8px 12px;
  }
  .rm-settings-close-list,
  .rm-settings-back {
    display: inline-flex;
  }
  .rm-settings-content {
    padding: 0 16px 16px;
  }
  .rm-settings-search {
    min-height: 44px;
  }
  .rm-settings-tab {
    min-height: 44px;
  }
  .rm-settings-save {
    max-width: 6em;
  }
  .rm-settings :deep(.rm-setting-info) {
    flex-basis: 100%;
  }
  .rm-settings :deep(.rm-setting-control) {
    width: 100%;
    max-width: 100%;
  }
}

:global(.rm-settings-modal.el-dialog) {
  width: min(960px, calc(100vw - 48px));
  padding: 0;
  overflow: hidden;
  background: transparent;
}
:global(.rm-settings-modal > .el-dialog__header) {
  display: none;
}
:global(.rm-settings-modal > .el-dialog__body) {
  padding: 0;
  max-height: none;
  overflow: hidden;
}
.rm-settings {
  max-height: none;
  border-radius: 12px;
}
.rm-settings-search {
  width: calc(100% - 16px);
  padding: 0;
  border: none;
  background: none;
}
@media (max-width: 767px) {
  :global(.rm-settings-modal.el-dialog) {
    width: 100%;
    max-width: 100vw;
    margin: 0;
    border-radius: 0;
  }
  .rm-settings {
    border-radius: 0;
  }
}
</style>
