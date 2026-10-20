<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, ApiError, type Theme } from './api'
import { appearancePaused, type CssSnippet } from '../themes/appearance'
import { loadSettings, reloadTheme, settings, updateSettings, type Settings } from './settings'
import { toast } from './workspace'

const themes = ref<Theme[]>([{ id: 'default', name: '默认', version: '1' }])
const error = ref('')
const busy = ref(false)
const editing = ref<string | null>(null)
const draft = ref({ name: '', css: '' })
const missingTheme = computed(() => !themes.value.some((theme) => theme.id === settings.theme))

async function refreshThemes() {
  error.value = ''
  try {
    themes.value = await api.themes()
    await reloadTheme()
  }
  catch (err) { error.value = err instanceof ApiError ? err.message : '读取主题失败，请检查网络' }
}
onMounted(refreshThemes)

async function change(patch: Partial<Settings>): Promise<boolean> {
  busy.value = true
  try {
    await updateSettings(patch)
    return true
  } catch (err) {
    toast('保存外观失败：' + (err instanceof ApiError ? err.message : '网络错误，请检查连接'))
    void loadSettings().catch((err) => toast('重新读取外观失败：' + (err instanceof ApiError ? err.message : '网络错误')))
    return false
  } finally { busy.value = false }
}

function edit(snippet?: CssSnippet) {
  editing.value = snippet?.id ?? ''
  draft.value = { name: snippet?.name ?? '', css: snippet?.css ?? '' }
}

async function saveSnippet() {
  if (!draft.value.name.trim()) return
  const snippets = settings.cssSnippets.map((s) => ({ ...s }))
  const existing = snippets.find((s) => s.id === editing.value)
  if (existing) Object.assign(existing, draft.value, { name: draft.value.name.trim() })
  else {
    // getRandomValues 在局域网 HTTP 开发页面也可用，randomUUID 需要安全上下文。
    const id = [...crypto.getRandomValues(new Uint32Array(4))].map((n) => n.toString(16).padStart(8, '0')).join('')
    snippets.push({ ...draft.value, name: draft.value.name.trim(), id, enabled: true })
  }
  if (await change({ cssSnippets: snippets })) editing.value = null
}

async function toggle(snippet: CssSnippet) {
  await change({ cssSnippets: settings.cssSnippets.map((s) => s.id === snippet.id ? { ...s, enabled: !s.enabled } : { ...s }) })
}

async function remove(snippet: CssSnippet) {
  if (!window.confirm(`删除 CSS 片段“${snippet.name}”？`)) return
  if (await change({ cssSnippets: settings.cssSnippets.filter((s) => s.id !== snippet.id) })) {
    if (editing.value === snippet.id) editing.value = null
  }
}

async function reset() {
  if (!await change({ colorMode: 'system', theme: 'default', fontSize: 16, contentWidth: 760,
    cssSnippets: settings.cssSnippets.map((s) => ({ ...s, enabled: false })) })) return
  toast('已恢复默认外观，CSS 片段已停用并保留')
}
</script>

<template>
  <p v-if="appearancePaused" class="rm-appearance-note">已临时停用主题和 CSS。可恢复默认外观后重新打开页面。</p>
  <div class="rm-setting">
    <label for="rm-color-mode" class="rm-setting-label">明暗模式</label>
    <select id="rm-color-mode" :value="settings.colorMode" :disabled="busy" @change="change({ colorMode: ($event.target as HTMLSelectElement).value as Settings['colorMode'] })">
      <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
    </select>
  </div>
  <div class="rm-setting">
    <label for="rm-theme-select" class="rm-setting-label">主题</label>
    <select id="rm-theme-select" :value="settings.theme" :disabled="busy" @change="change({ theme: ($event.target as HTMLSelectElement).value })">
      <option v-for="theme in themes" :key="theme.id" :value="theme.id">{{ theme.name }}</option>
      <option v-if="missingTheme" :value="settings.theme">{{ settings.theme }}（不可用）</option>
    </select>
    <button class="rm-btn" :disabled="busy" @click="refreshThemes">刷新列表</button>
  </div>
  <p v-if="error" class="rm-appearance-note rm-auth-error">{{ error }}</p>
  <p class="rm-appearance-note">主题从服务器数据目录的 themes 文件夹读取；主题和已启用的 CSS 也会应用到分享页。</p>
  <div class="rm-setting"><span class="rm-setting-label">CSS 片段</span><button class="rm-btn" :disabled="busy" @click="edit()">新建片段</button></div>
  <div v-for="snippet in settings.cssSnippets" :key="snippet.id" class="rm-snippet-row">
    <label><input type="checkbox" :checked="snippet.enabled" :disabled="busy" @change="toggle(snippet)" />{{ snippet.name }}</label>
    <button class="rm-btn" :disabled="busy" @click="edit(snippet)">编辑</button>
    <button class="rm-btn rm-btn-danger" :disabled="busy" @click="remove(snippet)">删除</button>
  </div>
  <form v-if="editing !== null" class="rm-snippet-form" @submit.prevent="saveSnippet">
    <label>片段名称<input v-model="draft.name" aria-label="片段名称" maxlength="100" required /></label>
    <label>CSS<textarea v-model="draft.css" aria-label="CSS" rows="9" spellcheck="false" placeholder=":root { --rm-accent: #805ad5; }" /></label>
    <div><button class="rm-btn" :disabled="busy" type="submit">保存并应用</button> <button class="rm-btn" type="button" @click="editing = null">取消</button></div>
  </form>
  <div class="rm-setting"><span class="rm-setting-label">默认外观</span><button class="rm-btn" :disabled="busy" @click="reset">恢复默认外观</button></div>
  <p class="rm-appearance-note">若自定义样式导致界面无法操作，可在地址末尾加 <code>?reset-appearance</code>，临时停用后再恢复默认。</p>
</template>
