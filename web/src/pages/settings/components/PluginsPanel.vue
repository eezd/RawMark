<script setup lang="ts">
import type { InstalledPlugin } from '@@/apis/plugins/type'
import { pluginsApi } from '@@/apis/plugins'
import { computed, ref } from 'vue'
import { ApiError } from '@/http/axios'
import PluginMount from '../../../common/components/PluginMount.vue'
import { pluginState, refreshPlugins, retryPlugin } from '../../../common/plugins/host'
import { pluginsPaused, settingTabs } from '../../../common/plugins/registry'

const busy = ref(false)
const error = ref('')
const fileInput = ref<HTMLInputElement>()
const selected = ref('')
const currentTab = computed(() => settingTabs.get(selected.value))
const labels: Record<string, string> = { loading: '加载中', active: '运行中', error: '故障停用', disabled: '已停用', paused: '临时跳过' }

async function perform(operation: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    await operation(); await refreshPlugins()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '插件操作失败，请检查连接后重试'
  } finally {
    busy.value = false
  }
}

async function install(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!window.confirm('插件在页面内拥有完整权限，可读取和修改全部笔记及账户数据。仅安装你信任的插件。确认安装？')) return
  await perform(() => pluginsApi.installPlugin(file))
}

async function remove(plugin: InstalledPlugin) {
  if (!window.confirm(`卸载插件“${plugin.name}”？将停用并删除插件文件，保留插件数据。`)) return
  await perform(() => pluginsApi.uninstallPlugin(plugin.id))
}

function toggle(plugin: InstalledPlugin) {
  void perform(() => pluginsApi.togglePlugin(plugin.id, !plugin.enabled))
}
</script>

<template>
  <p v-if="pluginsPaused" class="rm-appearance-note">
    已临时跳过外部插件。可停用问题插件后，移除地址中的 disable-plugins 参数重新打开。
  </p>
  <div class="rm-setting">
    <span class="rm-setting-label">已安装插件</span>
    <el-button class="rm-btn" :disabled="busy" @click="perform(() => refreshPlugins())">
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
  <div v-for="plugin in pluginState.installed" :key="plugin.id" class="rm-plugin-row">
    <label><input type="checkbox" :checked="plugin.enabled" :disabled="busy" @change="toggle(plugin)">
      <span>{{ plugin.name }} <small>{{ plugin.version }} · {{ labels[pluginState.status[plugin.id]?.phase] ?? (plugin.enabled ? '等待加载' : '已停用') }}</small></span>
    </label>
    <el-button v-if="plugin.enabled && pluginState.status[plugin.id]?.phase === 'error'" class="rm-btn" :disabled="busy || pluginsPaused" @click="retryPlugin(plugin.id)">
      重试
    </el-button>
    <el-button class="rm-btn rm-btn-danger" :disabled="busy" @click="remove(plugin)">
      卸载
    </el-button>
    <p v-if="pluginState.status[plugin.id]?.error" class="rm-auth-error">
      {{ pluginState.status[plugin.id].error }}
    </p>
  </div>
  <p class="rm-appearance-note">
    若插件导致界面无法操作，在应用地址末尾加 <code>?disable-plugins</code> 可跳过加载并打开此页。卸载保留插件数据。
  </p>
  <template v-if="settingTabs.size">
    <div class="rm-setting">
      <label for="rm-plugin-tab" class="rm-setting-label">插件设置</label>
      <select id="rm-plugin-tab" v-model="selected">
        <option value="">
          选择插件设置页
        </option><option v-for="[id, tab] in settingTabs" :key="id" :value="id">
          {{ tab.title }}
        </option>
      </select>
    </div>
    <PluginMount v-if="currentTab" :key="selected" :view="currentTab" />
  </template>
</template>
