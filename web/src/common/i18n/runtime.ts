import { createI18n } from 'vue-i18n'
import en from './en.json'
import zhCN from './zh-CN.json'

export const LOCALES = ['en', 'zh-CN'] as const
export type Locale = typeof LOCALES[number]
export const DEFAULT_LOCALE: Locale = 'en'
export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh-CN'
}

const cached = typeof localStorage === 'undefined' ? {} : JSON.parse(localStorage.getItem('rawmark.settings') ?? '{}')
const initialLocale = isLocale(cached.locale) ? cached.locale : DEFAULT_LOCALE
export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: false,
  messages: { 'en': { common: en }, 'zh-CN': { common: zhCN } },
})
export const locale = i18n.global.locale
export function t(key: string, params: Record<string, unknown> = {}): string {
  return i18n.global.t(key, params)
}
export function applyLocale(value: Locale) {
  locale.value = value
  if (typeof document !== 'undefined') document.documentElement.lang = value
}

/** 登录页仅缓存显示语言；登录后由服务器账户设置覆盖。 */
export function chooseAnonymousLocale(value: Locale) {
  const cached = JSON.parse(localStorage.getItem('rawmark.settings') ?? '{}')
  localStorage.setItem('rawmark.settings', JSON.stringify({ ...cached, locale: value }))
  applyLocale(value)
}

applyLocale(initialLocale)
