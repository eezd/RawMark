import type { Appearance } from '@@/appearance/appearance'
import { getFontsApi } from '@@/apis/fonts'
import { getSettingsApi, patchSettingsApi } from '@@/apis/settings'
import { getThemeApi } from '@@/apis/themes'
import { appearancePaused, applyAppearance, sanitizeAppearance } from '@@/appearance/appearance'

import { applyFontCatalog, customFonts, parseFontCatalog } from '@@/appearance/fonts'
import { applyDisplaySettings, DISPLAY_DEFAULTS, FONT_PRESETS, sanitizeDisplaySettings } from '@@/appearance/typography'
import { applyLocale, DEFAULT_LOCALE, isLocale, t as translate } from '@@/i18n/runtime'
import { normalizeKeys } from '@@/utils/keys'
import { isCancel } from 'axios'
import { defineStore } from 'pinia'
// Application settings are one server JSON object shared across devices; changes save immediately and sync through events.
// Apply the last local cache at startup to avoid flashing default values before saved settings appear.
import { reactive } from 'vue'
import { pinia } from '@/pinia'
import { useUserStore } from './user'

export const TAB_SIZES = [2, 4, 8]
// 0 means full width.
export const CONTENT_WIDTHS = [
  { get label() {
    return translate('common.narrow_a614db')
  }, value: 680 },
  { get label() {
    return translate('common.standard_6bea77')
  }, value: 760 },
  { get label() {
    return translate('common.wide_8dd966')
  }, value: 960 },
  { get label() {
    return translate('common.full_width_8ecc7d')
  }, value: 0 },
]

export const SIDEBAR_WIDTH = { min: 200, max: 480 }

export const DEFAULTS = { locale: DEFAULT_LOCALE, trashRetentionDays: 30, hiddenFonts: [] as string[], selectionToolbar: true, ...DISPLAY_DEFAULTS, sidebarWidth: 288, spellcheck: false, tabSize: 4 }
export type Settings = typeof DEFAULTS & Appearance & { shortcuts: Record<string, string[]> }

const CACHE_KEY = 'rawmark.settings'

export type SettingsSection = 'appearance' | 'editor' | 'account' | 'shortcuts' | 'trash' | 'plugins' | 'about' | 'storage'

export class SettingsAppearanceError extends Error {
  constructor(cause: unknown) {
    super(translate('common.settings_saved_but_the_theme_9f87f8', { p0: cause instanceof Error ? cause.message : String(cause) }), { cause })
  }
}

// Server settings may come from older versions, APIs, or plugins; invalid values fall back to defaults.
function sanitize(raw: Record<string, unknown>): Settings {
  const pick = <T>(v: unknown, allowed: T[], def: T) => (allowed.includes(v as T) ? (v as T) : def)
  const hiddenFonts = Array.isArray(raw.hiddenFonts) ? raw.hiddenFonts.filter((id): id is string => typeof id === 'string' && id !== 'maple' && Object.hasOwn(FONT_PRESETS, id)) : []
  return {
    locale: isLocale(raw.locale) ? raw.locale : DEFAULT_LOCALE,
    hiddenFonts,
    trashRetentionDays: Number.isSafeInteger(raw.trashRetentionDays) && (raw.trashRetentionDays as number) >= 0 ? raw.trashRetentionDays as number : DEFAULTS.trashRetentionDays,
    ...sanitizeDisplaySettings(raw, customFonts.value.map(font => font.id), hiddenFonts),
    selectionToolbar: typeof raw.selectionToolbar === 'boolean' ? raw.selectionToolbar : true,
    shortcuts: sanitizeShortcuts(raw.shortcuts),
    spellcheck: typeof raw.spellcheck === 'boolean' ? raw.spellcheck : DEFAULTS.spellcheck,
    tabSize: pick(raw.tabSize, TAB_SIZES, DEFAULTS.tabSize),
    ...sanitizeAppearance(raw),
    sidebarWidth:
      Number.isInteger(raw.sidebarWidth) && (raw.sidebarWidth as number) >= SIDEBAR_WIDTH.min && (raw.sidebarWidth as number) <= SIDEBAR_WIDTH.max
        ? (raw.sidebarWidth as number)
        : DEFAULTS.sidebarWidth,
  }
}

function sanitizeShortcuts(raw: unknown): Record<string, string[]> {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(translate('common.invalid_shortcut_settings_2f07e6'))
  const out: Record<string, string[]> = {}
  for (const [id, keys] of Object.entries(raw)) {
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) throw new Error(translate('common.invalid_shortcut_settings_2f07e6'))
    out[id] = keys.map(normalizeKeys)
  }
  return out
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = reactive<Settings>(sanitize(JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}')))
  const settingsSave = reactive({ pending: 0, result: 'idle' as 'idle' | 'saved' | 'error', error: '' })

  let currentTheme = ''
  let currentCSS = ''
  let appearanceRequest = 0

  async function applySettingsAppearance() {
    const request = ++appearanceRequest
    const theme = settings.theme
    if (appearancePaused || theme === 'default') {
      currentTheme = theme
      currentCSS = ''
    } else if (theme !== currentTheme) {
      const data = (await getThemeApi(theme)).data
      if (request !== appearanceRequest) return
      currentCSS = data.css
      currentTheme = theme
    }
    applyAppearance({ ...settings }, currentCSS)
  }

  function applied(next: Settings) {
    Object.assign(settings, next)
    applyLocale(settings.locale)
    localStorage.setItem(CACHE_KEY, JSON.stringify(settings))
    const root = document.documentElement.style
    applyDisplaySettings(settings)
    root.setProperty('--rm-sidebar-width', `${settings.sidebarWidth}px`)
  }

  applied({ ...settings })
  // Apply only cached light/dark mode early; wait for server confirmation before themes and snippets.
  applyAppearance({ ...settings, theme: 'default', cssSnippets: [] }, '')

  let settingsRequest = 0
  async function loadSettings() {
    const user = useUserStore(pinia)
    const version = user.getSessionVersion()
    const request = ++settingsRequest
    if (settingsSave.pending) {
      // Events may precede PATCH responses; wait for existing writes before reading to avoid loading unsaved old values.
      await saveQueue
      user.assertSession(version)
      if (request !== settingsRequest) return
    }
    const [raw, fonts] = await Promise.all([getSettingsApi().then(({ data }) => data), getFontsApi().then(({ data }) => data.fonts)])
    user.assertSession(version)
    // Apply the catalog and settings together; late old responses must not restore deleted fonts or overwrite newer settings.
    if (request !== settingsRequest) return
    applyFontCatalog(parseFontCatalog(fonts))
    applied(sanitize(raw))
    await applySettingsAppearance()
  }

  async function reloadTheme() {
    currentTheme = ''
    await applySettingsAppearance()
  }

  /** Apply setting changes locally before saving; on failure the caller reports the error and reloads. */
  async function updateSettings(patch: Partial<Settings>) {
    ++settingsRequest
    applied({ ...settings, ...patch })
    // Serialize setting requests so rapid switches or snippet edits cannot let old requests overwrite newer values.
    await saveSettings(patch)
    try {
      await applySettingsAppearance()
    } catch (cause) {
      if (isCancel(cause)) throw cause
      throw new SettingsAppearanceError(cause)
    }
  }

  let saveQueue: Promise<unknown> = Promise.resolve()
  function saveSettings(patch: Partial<Settings>) {
    const user = useUserStore(pinia)
    const version = user.getSessionVersion()
    settingsSave.pending++
    const pending = saveQueue.then(async () => {
      try {
        user.assertSession(version)
        await patchSettingsApi(patch)
        user.assertSession(version)
        settingsSave.result = 'saved'
        settingsSave.error = ''
      } catch (cause) {
        if (isCancel(cause)) throw cause
        settingsSave.result = 'error'
        settingsSave.error = cause instanceof Error ? cause.message : String(cause)
        throw cause
      } finally {
        settingsSave.pending--
      }
    })
    saveQueue = pending.catch(() => {})
    return pending
  }

  /** Wait for pending settings saves before maintenance; do not replace configuration if saving fails. */
  async function flushSettings() {
    await saveQueue
    if (settingsSave.result === 'error') throw new Error(translate('common.could_not_save_settings_1cdd7f', { p0: settingsSave.error }))
  }

  return { settings, settingsSave, loadSettings, updateSettings, flushSettings, reloadTheme }
})
