// 编辑器排版设置；账户、快捷键等设置不进入此模块。
export const TEXT_FONTS = {
  sans: { label: 'Manrope · 清晰无衬线', css: "'Manrope', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  serif: { label: 'Noto Serif SC · 思源宋体', css: "'Noto Serif SC', 'Source Han Serif SC', serif" },
  system: { label: '系统字体', css: 'system-ui, sans-serif' },
}
export const CODE_FONTS = {
  jetbrains: { label: 'JetBrains Mono', css: "'JetBrains Mono', ui-monospace, monospace" },
  system: { label: '系统等宽字体', css: 'ui-monospace, monospace' },
}
export const UI_FONT_SIZE = { min: 14, max: 20, default: 14 }
export const DISPLAY_DEFAULTS = { uiFontSize: UI_FONT_SIZE.default, fontSize: 16, contentWidth: 760, textFont: 'sans' as keyof typeof TEXT_FONTS, codeFont: 'jetbrains' as keyof typeof CODE_FONTS, lineHeight: 1.75, paragraphSpacing: 16, glassOpacity: .75 }
export type DisplaySettings = typeof DISPLAY_DEFAULTS
export function sanitizeDisplaySettings(raw: Record<string, unknown>): DisplaySettings {
  const ranged = (key: 'lineHeight' | 'paragraphSpacing' | 'glassOpacity', min: number, max: number) => typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= min && raw[key] <= max ? raw[key] : DISPLAY_DEFAULTS[key]
  return {
    uiFontSize: typeof raw.uiFontSize === 'number' && Number.isInteger(raw.uiFontSize) && raw.uiFontSize >= UI_FONT_SIZE.min && raw.uiFontSize <= UI_FONT_SIZE.max ? raw.uiFontSize : UI_FONT_SIZE.default,
    fontSize: typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize) && raw.fontSize > 0 ? raw.fontSize : 16,
    contentWidth: typeof raw.contentWidth === 'number' && [0, 680, 760, 960].includes(raw.contentWidth) ? raw.contentWidth : 760,
    textFont: raw.textFont === 'serif' || raw.textFont === 'system' ? raw.textFont : 'sans',
    codeFont: raw.codeFont === 'system' ? 'system' : 'jetbrains',
    lineHeight: ranged('lineHeight', 1.2, 2.5), paragraphSpacing: ranged('paragraphSpacing', 0, 40), glassOpacity: ranged('glassOpacity', .4, 1),
  }
}
export function applyDisplaySettings(settings: DisplaySettings) {
  const root = document.documentElement.style
  root.setProperty('--rm-ui-font-size', settings.uiFontSize + 'px')
  root.setProperty('--rm-font-size', settings.fontSize + 'px')
  root.setProperty('--rm-content-width', settings.contentWidth ? settings.contentWidth + 'px' : 'none')
  root.setProperty('--rm-font-editor', TEXT_FONTS[settings.textFont].css)
  root.setProperty('--rm-font-mono', CODE_FONTS[settings.codeFont].css)
  root.setProperty('--rm-line-height', String(settings.lineHeight))
  root.setProperty('--rm-paragraph-spacing', settings.paragraphSpacing + 'px')
  root.setProperty('--rm-glass-opacity', String(settings.glassOpacity))
}
