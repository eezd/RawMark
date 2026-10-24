// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { applyDisplaySettings, DISPLAY_DEFAULTS, sanitizeDisplaySettings } from './typography'

afterEach(() => document.documentElement.removeAttribute('style'))

describe('界面与正文排版设置', () => {
  it('旧设置缺少界面字号时使用 14px，保留正文字号', () => {
    expect(sanitizeDisplaySettings({ fontSize: 24 })).toMatchObject({ uiFontSize: 14, fontSize: 24 })
  })

  it.each([14, 16, 20])('接受范围内的整数界面字号 %s', uiFontSize => {
    expect(sanitizeDisplaySettings({ uiFontSize }).uiFontSize).toBe(uiFontSize)
  })

  it.each([13, 21, 16.5, '18', null, Number.NaN, Number.POSITIVE_INFINITY])('拒绝非法界面字号 %s', uiFontSize => {
    expect(sanitizeDisplaySettings({ uiFontSize }).uiFontSize).toBe(14)
  })

  it('应用界面字号不改变正文、代码字体和正文宽度', () => {
    const display = sanitizeDisplaySettings({ uiFontSize: 20, fontSize: 24, contentWidth: 960, textFont: 'serif', codeFont: 'system' })
    applyDisplaySettings(display)
    const style = document.documentElement.style
    expect(style.getPropertyValue('--rm-ui-font-size')).toBe('20px')
    expect(style.getPropertyValue('--rm-font-size')).toBe('24px')
    expect(style.getPropertyValue('--rm-content-width')).toBe('960px')
    expect(style.getPropertyValue('--rm-font-editor')).toContain('Noto Serif SC')
    expect(style.getPropertyValue('--rm-font-mono')).toBe('ui-monospace, monospace')
    applyDisplaySettings({ ...display, uiFontSize: DISPLAY_DEFAULTS.uiFontSize })
    expect(style.getPropertyValue('--rm-ui-font-size')).toBe('14px')
    expect(style.getPropertyValue('--rm-font-size')).toBe('24px')
  })
})
