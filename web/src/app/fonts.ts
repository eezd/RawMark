import { shallowRef } from 'vue'
import { api, type CustomFont } from './api'

export const customFonts = shallowRef<CustomFont[]>([])

export function applyFontCatalog(fonts: CustomFont[]) {
  customFonts.value = fonts
  let style = document.getElementById('rm-custom-fonts')
  if (!style) { style = document.createElement('style'); style.id = 'rm-custom-fonts'; document.head.append(style) }
  // 名称仅用于界面；CSS 标识和资源路径只由服务端内容哈希构成。
  const css = fonts.map(font => `@font-face { font-family: '${font.id}'; src: url('/api/v1/fonts/${font.id}/file'); font-display: block; }`).join('\n')
  if (style.textContent !== css) style.textContent = css
}

export function parseFontCatalog(value: unknown): CustomFont[] {
  if (!Array.isArray(value) || value.some(font => !font || typeof font !== 'object' || !/^custom-[a-f0-9]{64}$/.test(font.id) || typeof font.name !== 'string' || !['ttf', 'otf', 'woff', 'woff2'].includes(font.format))) throw new Error('字体列表格式无效')
  return value
}

export async function loadFonts() {
  applyFontCatalog(parseFontCatalog(await api.fonts()))
}
