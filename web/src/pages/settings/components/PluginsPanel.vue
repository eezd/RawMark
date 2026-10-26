<script setup lang="ts">
import type { InstalledPlugin } from '@@/apis/plugins/type'
import { installPluginApi, togglePluginApi, uninstallPluginApi } from '@@/apis/plugins'

import PluginMount from '@@/components/PluginMount/index.vue'

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
const labels: Record<string, string> = { loading: '加载中', active: '运行中', error: '故障停用', disabled: '已停用', paused: '临时跳过' }

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
  }, '插件在页面内拥有完整权限，可读取和修改全部笔记及账户数据。仅安装你信任的插件。确认安装？')
}

async function remove(plugin: InstalledPlugin) {
  await perform(async () => {
    await uninstallPluginApi(plugin.id); await refreshPlugins()
  }, `卸载插件“${plugin.name}”？将停用并删除插件文件，保留插件数据。`)
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
    已临时跳过外部插件。可停用问题插件后，移除地址中的 disable-plugins 参数重新打开。
  </p>
  <div class="rm-setting">
    <span class="rm-setting-label">已安装插件</span>
    <el-button class="rm-btn" :disabled="busy" @click="perform()">
      刷新列表
    </el-button>
    <el-button class="rm-btn" :disabled="busy" @click="fileInput?.click()">
      安装 ZIP
    </el-button>
    <input ref="fileInput" type="file" accept=".zip,application/zip" hidden @change="install">
  </div>
  <p class="rm-appearance-note">
    插件拥有页面内完整权限，请只安装可信来源。安装后默认停用；启用状态在所有设备同步。
  </p>
  <p v-if="error || pluginState.error" class="rm-appearance-note rm-auth-error">
    {{ error || pluginState.error }}
  </p>
  <p v-if="!pluginState.installed.length && !pluginState.error" class="rm-appearance-note">
    尚未安装插件。
  </p>
  <el-table :data="pluginState.installed" row-key="id" empty-text="尚未安装插件" :aria-busy="busy">
    <!-- @vue-generic {InstalledPlugin} -->
    <el-table-column label="插件" min-width="170">
      <template #default="{ row: plugin }">
        <strong>{{ plugin.name }}</strong><small class="rm-plugin-version">{{ plugin.version }} · {{ labels[pluginState.status[plugin.id]?.phase] ?? (plugin.enabled ? '等待加载' : '已停用') }}</small><p v-if="pluginState.status[plugin.id]?.error" class="rm-auth-error">
          {{ pluginState.status[plugin.id].error }}
        </p>
      </template>
    </el-table-column>
    <!-- @vue-generic {InstalledPlugin} -->
    <el-table-column label="启用" width="72">
      <template #default="{ row: plugin }">
        <el-switch :model-value="plugin.enabled" :disabled="busy" :aria-label="`启用 ${plugin.name}`" @change="toggle(plugin)" />
      </template>
    </el-table-column>
    <!-- @vue-generic {InstalledPlugin} -->
    <el-table-column label="操作" width="130">
      <template #default="{ row: plugin }">
        <el-button v-if="plugin.enabled && pluginState.status[plugin.id]?.phase === 'error'" text :disabled="busy || pluginsPaused" @click="perform(() => retryPlugin(plugin.id))">
          重试
        </el-button><el-button text type="danger" :disabled="busy" @click="remove(plugin)">
          卸载
        </el-button>
      </template>
    </el-table-column>
  </el-table>
  <p class="rm-appearance-note">
    若插件导致界面无法操作，在应用地址末尾加 <code>?disable-plugins</code> 可跳过加载并打开此页。卸载保留插件数据。
  </p>
  <template v-if="settingTabs.size">
    <div class="rm-setting">
      <label for="rm-plugin-tab" class="rm-setting-label">插件设置</label>
      <el-select id="rm-plugin-tab" v-model="selected" clearable placeholder="选择插件设置页">
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
