// 编辑器排版设置；账户、快捷键等设置不进入此模块。
const maple = { label: 'Maple Mono Normal NL NF CN', css: "'Maple Mono Normal NL NF CN', monospace" }
export const TEXT_FONTS = {
  maple,
  sans: { label: 'Manrope · 清晰无衬线', css: "'Manrope', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  serif: { label: 'Noto Serif SC · 思源宋体', css: "'Noto Serif SC', 'Source Han Serif SC', serif" },
  system: { label: '系统字体', css: 'system-ui, sans-serif' },
}
export const CODE_FONTS = {
  maple,
  jetbrains: { label: 'JetBrains Mono', css: "'JetBrains Mono', ui-monospace, monospace" },
  system: { label: '系统等宽字体', css: 'ui-monospace, monospace' },
}
export const UI_FONT_SIZE = { min: 14, max: 20, default: 14 }
export const FONT_PRESETS: Record<string, { label: string; css: string }> = { ...TEXT_FONTS, jetbrains: CODE_FONTS.jetbrains }
export const DISPLAY_DEFAULTS = { uiFont: 'maple', uiFontSize: UI_FONT_SIZE.default, fontSize: 16, contentWidth: 760, textFont: 'maple', codeFont: 'maple', lineHeight: 1.75, paragraphSpacing: 16, glassOpacity: .75 }
export type DisplaySettings = typeof DISPLAY_DEFAULTS
export function sanitizeDisplaySettings(raw: Record<string, unknown>, customIDs: string[] = [], hiddenFonts: string[] = []): DisplaySettings {
  const ranged = (key: 'lineHeight' | 'paragraphSpacing' | 'glassOpacity', min: number, max: number) => typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= min && raw[key] <= max ? raw[key] : DISPLAY_DEFAULTS[key]
  const font = (value: unknown) => typeof value === 'string' && !hiddenFonts.includes(value) && (Object.hasOwn(FONT_PRESETS, value) || customIDs.includes(value)) ? value : 'maple'
  return {
    uiFont: font(raw.uiFont),
    uiFontSize: typeof raw.uiFontSize === 'number' && Number.isInteger(raw.uiFontSize) && raw.uiFontSize >= UI_FONT_SIZE.min && raw.uiFontSize <= UI_FONT_SIZE.max ? raw.uiFontSize : UI_FONT_SIZE.default,
    fontSize: typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize) && raw.fontSize > 0 ? raw.fontSize : 16,
    contentWidth: typeof raw.contentWidth === 'number' && [0, 680, 760, 960].includes(raw.contentWidth) ? raw.contentWidth : 760,
    textFont: font(raw.textFont),
    codeFont: font(raw.codeFont),
    lineHeight: ranged('lineHeight', 1.2, 2.5), paragraphSpacing: ranged('paragraphSpacing', 0, 40), glassOpacity: ranged('glassOpacity', .4, 1),
  }
}
export function applyDisplaySettings(settings: DisplaySettings) {
  const root = document.documentElement.style
  const css = (id: string, code = false) => id === 'system' && code ? CODE_FONTS.system.css : FONT_PRESETS[id]?.css ?? `'${id}', ${maple.css}`
  root.setProperty('--rm-font-text', css(settings.uiFont))
  root.setProperty('--rm-ui-font-size', settings.uiFontSize + 'px')
  root.setProperty('--rm-font-size', settings.fontSize + 'px')
  root.setProperty('--rm-content-width', settings.contentWidth ? settings.contentWidth + 'px' : 'none')
  root.setProperty('--rm-font-editor', css(settings.textFont))
  root.setProperty('--rm-font-mono', css(settings.codeFont, true))
  root.setProperty('--rm-line-height', String(settings.lineHeight))
  root.setProperty('--rm-paragraph-spacing', settings.paragraphSpacing + 'px')
  root.setProperty('--rm-glass-opacity', String(settings.glassOpacity))
}
