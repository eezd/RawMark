// 应用设置：服务器上一份 JSON，全部设备共用；修改立即保存，其他设备经事件推送同步。
// 本地缓存上次的值，启动时先套用，避免页面先按默认值显示再跳变
import { reactive } from 'vue'
import { api } from './api'

export const FONT_SIZES = [14, 15, 16, 17, 18, 20, 22]
// 0 为全宽
export const CONTENT_WIDTHS = [
  { label: '窄', value: 680 },
  { label: '标准', value: 760 },
  { label: '宽', value: 960 },
  { label: '全宽', value: 0 },
]

export const SIDEBAR_WIDTH = { min: 200, max: 480 }

const DEFAULTS = { fontSize: 16, contentWidth: 760, sidebarWidth: 260 }
export type Settings = typeof DEFAULTS

const CACHE_KEY = 'rawmark.settings'

export const settings = reactive<Settings>(sanitize(JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}')))

// 服务器上的设置可能由旧版本、API 或插件写入，取值不合法的项退回默认值
function sanitize(raw: Record<string, unknown>): Settings {
  const pick = <T>(v: unknown, allowed: T[], def: T) => (allowed.includes(v as T) ? (v as T) : def)
  return {
    fontSize: pick(raw.fontSize, FONT_SIZES, DEFAULTS.fontSize),
    contentWidth: pick(
      raw.contentWidth,
      CONTENT_WIDTHS.map((w) => w.value),
      DEFAULTS.contentWidth,
    ),
    sidebarWidth:
      Number.isInteger(raw.sidebarWidth) && (raw.sidebarWidth as number) >= SIDEBAR_WIDTH.min && (raw.sidebarWidth as number) <= SIDEBAR_WIDTH.max
        ? (raw.sidebarWidth as number)
        : DEFAULTS.sidebarWidth,
  }
}

function applied(next: Settings) {
  Object.assign(settings, next)
  localStorage.setItem(CACHE_KEY, JSON.stringify(settings))
  const root = document.documentElement.style
  root.setProperty('--rm-font-size', settings.fontSize + 'px')
  root.setProperty('--rm-content-width', settings.contentWidth ? settings.contentWidth + 'px' : 'none')
  root.setProperty('--rm-sidebar-width', settings.sidebarWidth + 'px')
}

applied({ ...settings })

export async function loadSettings() {
  applied(sanitize(await api.settings()))
}

/** 修改设置：先在本地生效再保存，保存失败时由调用方提示并重新载入 */
export async function updateSettings(patch: Partial<Settings>) {
  applied({ ...settings, ...patch })
  await api.patchSettings(patch)
}
