// 应用设置：服务器上一份 JSON，全部设备共用；修改立即保存，其他设备经事件推送同步。
// 本地缓存上次的值，启动时先套用，避免页面先按默认值显示再跳变
import { reactive } from 'vue'
import { DISPLAY_DEFAULTS, sanitizeDisplaySettings, applyDisplaySettings } from '../themes/typography'
import { api } from './api'
import { normalizeKeys } from '../keys'
import { applyAppearance, appearancePaused, sanitizeAppearance, type Appearance } from '../themes/appearance'

export const TAB_SIZES = [2, 4, 8]
// 0 为全宽
export const CONTENT_WIDTHS = [
  { label: '窄', value: 680 },
  { label: '标准', value: 760 },
  { label: '宽', value: 960 },
  { label: '全宽', value: 0 },
]

export const SIDEBAR_WIDTH = { min: 200, max: 480 }

export const DEFAULTS = { selectionToolbar: true, ...DISPLAY_DEFAULTS, sidebarWidth: 288, spellcheck: false, tabSize: 4 }
export type Settings = typeof DEFAULTS & Appearance & { shortcuts: Record<string, string[]> }

const CACHE_KEY = 'rawmark.settings'

export const settings = reactive<Settings>(sanitize(JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}')))
// 只记录写入结果；重新读取设置和主题应用不代表保存成功。
export const settingsSave = reactive({ pending: 0, result: 'idle' as 'idle' | 'saved' | 'error', error: '' })

export class SettingsAppearanceError extends Error {
  constructor(cause: unknown) {
    super('设置已保存，但主题应用失败：' + (cause instanceof Error ? cause.message : String(cause)), { cause })
  }
}

// 服务器上的设置可能由旧版本、API 或插件写入，取值不合法的项退回默认值
function sanitize(raw: Record<string, unknown>): Settings {
  const pick = <T>(v: unknown, allowed: T[], def: T) => (allowed.includes(v as T) ? (v as T) : def)
  return {
    ...sanitizeDisplaySettings(raw),
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('快捷键设置格式无效')
  const out: Record<string, string[]> = {}
  for (const [id, keys] of Object.entries(raw)) {
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) throw new Error('快捷键设置格式无效')
    out[id] = keys.map(normalizeKeys)
  }
  return out
}

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
    const data = await api.theme(theme)
    if (request !== appearanceRequest) return
    currentCSS = data.css
    currentTheme = theme
  }
  applyAppearance({ ...settings }, currentCSS)
}

function applied(next: Settings) {
  Object.assign(settings, next)
  localStorage.setItem(CACHE_KEY, JSON.stringify(settings))
  const root = document.documentElement.style
  applyDisplaySettings(settings)
  root.setProperty('--rm-sidebar-width', settings.sidebarWidth + 'px')
}

applied({ ...settings })
// 缓存只提前应用明暗模式；主题和片段等服务器确认后再应用。
applyAppearance({ ...settings, theme: 'default', cssSnippets: [] }, '')

export async function loadSettings() {
  applied(sanitize(await api.settings()))
  await applySettingsAppearance()
}

export async function reloadTheme() {
  currentTheme = ''
  await applySettingsAppearance()
}

/** 修改设置：先在本地生效再保存，保存失败时由调用方提示并重新载入 */
export async function updateSettings(patch: Partial<Settings>) {
  applied({ ...settings, ...patch })
  // 设置请求串行提交，防止快速切换和片段编辑的旧请求覆盖新值。
  await saveSettings(patch)
  try { await applySettingsAppearance() }
  catch (cause) { throw new SettingsAppearanceError(cause) }
}

let saveQueue: Promise<unknown> = Promise.resolve()
function saveSettings(patch: Partial<Settings>) {
  settingsSave.pending++
  const pending = saveQueue.then(async () => {
    try {
      await api.patchSettings(patch)
      settingsSave.result = 'saved'
      settingsSave.error = ''
    } catch (cause) {
      settingsSave.result = 'error'
      settingsSave.error = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally { settingsSave.pending-- }
  })
  saveQueue = pending.catch(() => {})
  return pending
}
