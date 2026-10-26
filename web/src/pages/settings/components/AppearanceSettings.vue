<script setup lang="ts">
import type { Theme } from '@@/apis/themes/type'
import type { CssSnippet } from '@@/appearance/appearance'

import type { Settings } from '@/pinia/stores/settings'
import { getThemesApi } from '@@/apis/themes'
import { appearancePaused, fixedThemeMode } from '@@/appearance/appearance'
import { DISPLAY_DEFAULTS } from '@@/appearance/typography'
import { confirmAction } from '@@/utils/confirm'

import { toast } from '@@/utils/notifications'
import { isCancel } from 'axios'
import { computed, onMounted, ref } from 'vue'
import { ApiError } from '@/http/axios'
import { pinia } from '@/pinia'
import { SettingsAppearanceError, useSettingsStore } from '@/pinia/stores/settings'
import SettingRow from './SettingRow.vue'

const { loadSettings, reloadTheme, settings, updateSettings } = useSettingsStore(pinia)

const themes = ref<Theme[]>([{ id: 'default', name: '默认', version: '1' }])
const error = ref('')
const busy = ref(false)
const editing = ref<string | null>(null)
const draft = ref({ name: '', css: '' })
const missingTheme = computed(() => !themes.value.some(theme => theme.id === settings.theme))
const fixedMode = computed(() => fixedThemeMode(settings.theme))

async function refreshThemes() {
  error.value = ''
  try {
    themes.value = (await getThemesApi()).data.themes
    await reloadTheme()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '读取主题失败，请检查网络'
  }
}
onMounted(refreshThemes)

async function change(patch: Partial<Settings>): Promise<boolean> {
  busy.value = true
  try {
    await updateSettings(patch)
    return true
  } catch (err) {
    if (isCancel(err)) return false
    if (err instanceof SettingsAppearanceError) {
      toast(err.message); return true
    }
    toast(`保存外观失败：${err instanceof ApiError ? err.message : '网络错误，请检查连接'}`)
    void loadSettings().catch((err) => {
      if (!isCancel(err)) toast(`重新读取外观失败：${err instanceof ApiError ? err.message : '网络错误'}`)
    })
    return false
  } finally {
    busy.value = false
  }
}

function edit(snippet?: CssSnippet) {
  editing.value = snippet?.id ?? ''
  draft.value = { name: snippet?.name ?? '', css: snippet?.css ?? '' }
}

async function saveSnippet() {
  if (!draft.value.name.trim()) return
  const snippets = settings.cssSnippets.map(s => ({ ...s }))
  const existing = snippets.find(s => s.id === editing.value)
  if (existing) {
    Object.assign(existing, draft.value, { name: draft.value.name.trim() })
  } else {
    // getRandomValues 在局域网 HTTP 开发页面也可用，randomUUID 需要安全上下文。
    const id = [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16).padStart(8, '0')).join('')
    snippets.push({ ...draft.value, name: draft.value.name.trim(), id, enabled: true })
  }
  if (await change({ cssSnippets: snippets })) editing.value = null
}

async function toggle(snippet: CssSnippet) {
  await change({ cssSnippets: settings.cssSnippets.map(s => s.id === snippet.id ? { ...s, enabled: !s.enabled } : { ...s }) })
}

async function remove(snippet: CssSnippet) {
  if (busy.value) return
  busy.value = true
  try {
    if (!await confirmAction(`删除 CSS 片段“${snippet.name}”？`)) return
    if (await change({ cssSnippets: settings.cssSnippets.filter(s => s.id !== snippet.id) })) {
      if (editing.value === snippet.id) editing.value = null
    }
  } finally {
    busy.value = false
  }
}

async function reset() {
  if (!await change({ colorMode: 'system', theme: 'default', ...DISPLAY_DEFAULTS, cssSnippets: settings.cssSnippets.map(s => ({ ...s, enabled: false })) })) {
    return
  }
  toast('已恢复默认外观与排版，CSS 片段已停用并保留')
}
</script>

<template>
  <p v-if="appearancePaused" class="rm-appearance-note">
    已临时停用主题和 CSS。可恢复默认外观后重新打开页面。
  </p>
  <SettingRow id="theme-select" control="rm-theme-select">
    <el-select id="rm-theme-select" :model-value="settings.theme" :disabled="busy" @change="change({ theme: $event })">
      <el-option v-for="theme in themes" :key="theme.id" :value="theme.id" :label="theme.name" />
      <el-option v-if="missingTheme" :value="settings.theme" :label="`${settings.theme}（不可用）`" />
    </el-select>
    <el-button class="rm-btn" :disabled="busy" @click="refreshThemes">
      刷新列表
    </el-button>
  </SettingRow>
  <SettingRow id="color-mode">
    <el-segmented :model-value="fixedMode ?? settings.colorMode" :disabled="busy || !!fixedMode" :options="[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' }]" aria-label="明暗模式" @change="change({ colorMode: $event as Settings['colorMode'] })" />
  </SettingRow>
  <p v-if="error" class="rm-appearance-note rm-auth-error" role="alert">
    {{ error }}
  </p>
  <p v-if="fixedMode" class="rm-appearance-note">
    白色、黑色主题固定使用对应明暗模式；切换回默认或自定义主题后可调整明暗设置。
  </p>
  <details class="rm-settings-details rm-appearance-advanced">
    <summary>自定义 CSS 与恢复</summary>
    <SettingRow id="css-snippets">
      <el-button class="rm-btn" :disabled="busy" @click="edit()">
        新建片段
      </el-button>
    </SettingRow>
    <div v-for="snippet in settings.cssSnippets" :key="snippet.id" class="rm-snippet-row">
      <el-checkbox :model-value="snippet.enabled" :disabled="busy" @change="toggle(snippet)">
        {{ snippet.name }}
      </el-checkbox>
      <el-button class="rm-btn" :disabled="busy" @click="edit(snippet)">
        编辑
      </el-button>
      <el-button class="rm-btn rm-btn-danger" :disabled="busy" @click="remove(snippet)">
        删除
      </el-button>
    </div>
    <el-form v-if="editing !== null" class="rm-snippet-form" label-position="top" @submit.prevent="saveSnippet">
      <label>片段名称<el-input v-model="draft.name" aria-label="片段名称" maxlength="100" required /></label>
      <label>CSS<el-input v-model="draft.css" type="textarea" aria-label="CSS" :rows="9" spellcheck="false" placeholder=":root { --rm-accent: #805ad5; }" /></label>
      <div>
        <el-button class="rm-btn" :disabled="busy" native-type="submit">
          保存并应用
        </el-button> <el-button class="rm-btn" native-type="button" @click="editing = null">
          取消
        </el-button>
      </div>
    </el-form>
    <SettingRow id="reset-appearance">
      <el-button class="rm-btn" :disabled="busy" @click="reset">
        恢复默认外观与排版
      </el-button>
    </SettingRow>
    <p class="rm-appearance-note">
      若自定义样式导致界面无法操作，可在地址末尾加 <code>?reset-appearance</code>，临时停用后再恢复默认。
    </p>
  </details>
</template>
