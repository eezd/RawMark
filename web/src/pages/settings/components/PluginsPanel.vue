<script setup lang="ts">
import type { InstalledPlugin } from '@@/apis/plugins/type'

import { installPluginApi, togglePluginApi, uninstallPluginApi } from '@@/apis/plugins'
import PluginMount from '@@/components/PluginMount/index.vue'

import { t as translate } from '@@/i18n/runtime'

import { pluginState, refreshPlugins, retryPlugin } from '@@/plugins/host'
import { pluginsPaused, settingTabs } from '@@/plugins/registry'
import { confirmAction } from '@@/utils/confirm'
import { isCancel } from 'axios'
import { computed, onMounted, ref } from 'vue'

const busy = ref(false)
const error = ref('')
const fileInput = ref<HTMLInputElement>()
const selected = ref('')
const currentTab = computed(() => settingTabs.get(selected.value))
const labels: Record<string, string> = { get loading() {
  return translate('settings.loading_d04fcb')
}, get active() {
  return translate('settings.running_1f0eb9')
}, get error() {
  return translate('settings.disabled_after_an_error_e8b7b5')
}, get disabled() {
  return translate('settings.disabled_a8c369')
}, get paused() {
  return translate('settings.temporarily_skipped_9f45ce')
} }

async function perform(operation: () => Promise<unknown> = refreshPlugins, confirmation?: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (confirmation && !await confirmAction(confirmation)) return
    await operation()
  } catch (err) {
    if (isCancel(err)) return
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function install(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  await perform(async () => {
    await installPluginApi(file); await refreshPlugins()
  }, translate('settings.plugins_have_full_access_to_7743b6'))
}

async function remove(plugin: InstalledPlugin) {
  await perform(async () => {
    await uninstallPluginApi(plugin.id); await refreshPlugins()
  }, translate('settings.uninstall_plugin_the_plugin_will_6aa869', { p0: plugin.name }))
}

function toggle(plugin: InstalledPlugin) {
  void perform(async () => {
    await togglePluginApi({ id: plugin.id, enabled: !plugin.enabled }); await refreshPlugins()
  })
}
onMounted(() => perform())
</script>

<template>
  <p v-if="pluginsPaused" class="rm-appearance-note">
    {{ translate('settings.external_plugins_are_temporarily_skipped_f85ce0') }}
  </p>
  <div class="rm-setting">
    <span class="rm-setting-label">{{ translate('settings.installed_plugins_e476c3') }}</span>
    <el-button class="rm-btn" :disabled="busy" @click="perform()">
      {{ translate('settings.refresh_list_e28be7') }}
    </el-button>
    <el-button class="rm-btn" :disabled="busy" @click="fileInput?.click()">
      {{ translate('settings.install_zip_4f1723') }}
    </el-button>
    <input ref="fileInput" type="file" accept=".zip,application/zip" hidden @change="install">
  </div>
  <p class="rm-appearance-note">
    {{ translate('settings.plugins_have_full_access_to_0cee40') }}
  </p>
  <p v-if="error || pluginState.error" class="rm-appearance-note rm-auth-error">
    {{ error || pluginState.error }}
  </p>
  <p v-if="!pluginState.installed.length && !pluginState.error" class="rm-appearance-note">
    {{ translate('settings.no_plugins_installed_eaaa06') }}
  </p>
  <el-table :data="pluginState.installed" row-key="id" :empty-text="translate('settings.no_plugins_installed_9d17e5')" :aria-busy="busy">
    <!-- @vue-generic {InstalledPlugin} -->
    <el-table-column :label="translate('settings.plugins_e806fb')" min-width="170">
      <template #default="{ row: plugin }">
        <strong>{{ plugin.name }}</strong><small class="rm-plugin-version">{{ plugin.version }} · {{ labels[pluginState.status[plugin.id]?.phase] ?? (plugin.enabled ? translate('settings.waiting_to_load_e1cfcb') : translate('settings.disabled_a8c369')) }}</small><p v-if="pluginState.status[plugin.id]?.error" class="rm-auth-error">
          {{ pluginState.status[plugin.id].error }}
        </p>
      </template>
    </el-table-column>
    <!-- @vue-generic {InstalledPlugin} -->
    <el-table-column :label="translate('settings.enable_f4f0ea')" width="72">
      <template #default="{ row: plugin }">
        <el-switch :model-value="plugin.enabled" :disabled="busy" :aria-label="translate('settings.enable_2a670f', { p0: plugin.name })" @change="toggle(plugin)" />
      </template>
    </el-table-column>
    <!-- @vue-generic {InstalledPlugin} -->
    <el-table-column :label="translate('settings.actions_ed31fb')" width="130">
      <template #default="{ row: plugin }">
        <el-button v-if="plugin.enabled && pluginState.status[plugin.id]?.phase === 'error'" text :disabled="busy || pluginsPaused" @click="perform(() => retryPlugin(plugin.id))">
          {{ translate('common.retry_b8784c') }}
        </el-button><el-button text type="danger" :disabled="busy" @click="remove(plugin)">
          {{ translate('settings.uninstall_06bc14') }}
        </el-button>
      </template>
    </el-table-column>
  </el-table>
  <p class="rm-appearance-note">
    {{ translate('settings.if_a_plugin_makes_the_46626f') }} <code>?disable-plugins</code> {{ translate('settings.to_the_app_url_to_db1658') }}
  </p>
  <template v-if="settingTabs.size">
    <div class="rm-setting">
      <label for="rm-plugin-tab" class="rm-setting-label">{{ translate('settings.plugin_settings_b1bc55') }}</label>
      <el-select id="rm-plugin-tab" v-model="selected" clearable :placeholder="translate('settings.choose_a_plugin_settings_page_7171ad')">
        <el-option v-for="[id, tab] in settingTabs" :key="id" :value="id" :label="tab.title" />
      </el-select>
    </div>
    <PluginMount v-if="currentTab" :key="selected" :view="currentTab" />
  </template>
</template>

<style scoped lang="scss">
.rm-plugin-version {
  display: block;
  color: var(--rm-text-muted);
  font-size: var(--rm-ui-font-small);
  margin-top: 4px;
}
</style>
