<script setup lang="ts">
import type { Theme } from '@@/apis/themes/type'

import type { CssSnippet } from '@@/appearance/appearance'
import type { Settings } from '@/pinia/stores/settings'

import { getThemesApi } from '@@/apis/themes'
import { appearancePaused, fixedThemeMode } from '@@/appearance/appearance'
import { DISPLAY_DEFAULTS } from '@@/appearance/typography'
import { t as translate } from '@@/i18n/runtime'
import { confirmAction } from '@@/utils/confirm'

import { toast } from '@@/utils/notifications'
import { isCancel } from 'axios'
import { computed, onMounted, ref } from 'vue'
import { ApiError } from '@/http/axios'
import { pinia } from '@/pinia'
import { SettingsAppearanceError, useSettingsStore } from '@/pinia/stores/settings'
import SettingRow from './SettingRow.vue'

const { loadSettings, reloadTheme, settings, updateSettings } = useSettingsStore(pinia)

const themes = ref<Theme[]>([{ id: 'default', get name() {
  return translate('common.default_844b8c')
}, version: '1' }])
const error = ref('')
const busy = ref(false)
const editing = ref<string | null>(null)
const draft = ref({ name: '', css: '' })
const missingTheme = computed(() => !themes.value.some(theme => theme.id === settings.theme))
const fixedMode = computed(() => fixedThemeMode(settings.theme))

function themeName(theme: Theme) {
  return theme.id === 'default' ? translate('common.default_844b8c') : theme.id === 'white' || theme.id === 'black' ? translate(`settings.theme_${theme.id}`) : theme.name
}

async function refreshThemes() {
  error.value = ''
  try {
    themes.value = (await getThemesApi()).data.themes
    await reloadTheme()
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : translate('settings.could_not_load_themes_check_8e9224')
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
    toast(translate('settings.could_not_save_appearance_70bfd0', { p0: err instanceof ApiError ? err.message : translate('common.network_error_check_your_connection_566064') }))
    void loadSettings().catch((err) => {
      if (!isCancel(err)) toast(translate('settings.could_not_reload_appearance_acc776', { p0: err instanceof ApiError ? err.message : translate('common.network_error') }))
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
    // getRandomValues works on LAN HTTP development pages; randomUUID requires a secure context.
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
    if (!await confirmAction(translate('settings.delete_css_snippet_bb7d52', { p0: snippet.name }))) return
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
  toast(translate('settings.default_appearance_and_typography_restored_85037c'))
}
</script>

<template>
  <p v-if="appearancePaused" class="rm-appearance-note">
    {{ translate('settings.themes_and_css_are_temporarily_0c0bf0') }}
  </p>
  <SettingRow id="theme-select" control="rm-theme-select">
    <el-select id="rm-theme-select" :model-value="settings.theme" :disabled="busy" @change="change({ theme: $event })">
      <el-option v-for="theme in themes" :key="theme.id" :value="theme.id" :label="themeName(theme)" />
      <el-option v-if="missingTheme" :value="settings.theme" :label="translate('settings.unavailable_6145a5', { p0: settings.theme })" />
    </el-select>
    <el-button class="rm-btn" :disabled="busy" @click="refreshThemes">
      {{ translate('settings.refresh_list_e28be7') }}
    </el-button>
  </SettingRow>
  <SettingRow id="color-mode">
    <el-segmented :model-value="fixedMode ?? settings.colorMode" :disabled="busy || !!fixedMode" :options="[{ value: 'light', get label() { return translate('settings.light_aa0819') } }, { value: 'dark', get label() { return translate('settings.dark_a6b75d') } }, { value: 'system', get label() { return translate('settings.system_217cfe') } }]" :aria-label="translate('settings.color_mode_65260b')" @change="change({ colorMode: $event as Settings['colorMode'] })" />
  </SettingRow>
  <p v-if="error" class="rm-appearance-note rm-auth-error" role="alert">
    {{ error }}
  </p>
  <p v-if="fixedMode" class="rm-appearance-note">
    {{ translate('settings.the_light_and_dark_themes_b3b0c9') }}
  </p>
  <details class="rm-settings-details rm-appearance-advanced">
    <summary>{{ translate('settings.custom_css_and_recovery_cc220b') }}</summary>
    <SettingRow id="css-snippets">
      <el-button class="rm-btn" :disabled="busy" @click="edit()">
        {{ translate('settings.new_snippet_b2808d') }}
      </el-button>
    </SettingRow>
    <div v-for="snippet in settings.cssSnippets" :key="snippet.id" class="rm-snippet-row">
      <el-checkbox :model-value="snippet.enabled" :disabled="busy" @change="toggle(snippet)">
        {{ snippet.name }}
      </el-checkbox>
      <el-button class="rm-btn" :disabled="busy" @click="edit(snippet)">
        {{ translate('common.edit_051836') }}
      </el-button>
      <el-button class="rm-btn rm-btn-danger" :disabled="busy" @click="remove(snippet)">
        {{ translate('common.delete_2f9daa') }}
      </el-button>
    </div>
    <el-form v-if="editing !== null" class="rm-snippet-form" label-position="top" @submit.prevent="saveSnippet">
      <label>{{ translate('settings.snippet_name_5679e2') }}<el-input v-model="draft.name" :aria-label="translate('settings.snippet_name_5679e2')" maxlength="100" required /></label>
      <label>CSS<el-input v-model="draft.css" type="textarea" aria-label="CSS" :rows="9" spellcheck="false" placeholder=":root { --rm-accent: #805ad5; }" /></label>
      <div>
        <el-button class="rm-btn" :disabled="busy" native-type="submit">
          {{ translate('settings.save_and_apply_a7ec01') }}
        </el-button> <el-button class="rm-btn" native-type="button" @click="editing = null">
          {{ translate('common.cancel_2cd0f3') }}
        </el-button>
      </div>
    </el-form>
    <SettingRow id="reset-appearance">
      <el-button class="rm-btn" :disabled="busy" @click="reset">
        {{ translate('settings.reset_appearance_and_typography_c73c09') }}
      </el-button>
    </SettingRow>
    <p class="rm-appearance-note">
      {{ translate('settings.if_custom_styles_make_the_aed659') }} <code>?reset-appearance</code>{{ translate('settings.to_the_url_to_temporarily_b75ce2') }}
    </p>
  </details>
</template>
