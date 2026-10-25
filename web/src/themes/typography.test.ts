// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { applyDisplaySettings, DISPLAY_DEFAULTS, sanitizeDisplaySettings } from './typography'

afterEach(() => document.documentElement.removeAttribute('style'))

describe('界面与正文排版设置', () => {
  it('旧设置缺少界面字号时使用 14px，保留正文字号', () => {
    expect(sanitizeDisplaySettings({ fontSize: 24 })).toMatchObject({ uiFontSize: 14, fontSize: 24 })
  })

  it('旧段间距设置不再进入正文排版，保留已设置的字号和行距', () => {
    const display = sanitizeDisplaySettings({ paragraphSpacing: 40, fontSize: 24, lineHeight: 2 })
    expect(display).not.toHaveProperty('paragraphSpacing')
    applyDisplaySettings(display)
    expect(document.documentElement.style.getPropertyValue('--rm-font-size')).toBe('24px')
    expect(document.documentElement.style.getPropertyValue('--rm-line-height')).toBe('2')
  })

  it.each([1.2, 1.75, 2.5])('保留并应用允许的正文行距 %s', lineHeight => {
    const display = sanitizeDisplaySettings({ lineHeight })
    expect(display.lineHeight).toBe(lineHeight)
    applyDisplaySettings(display)
    expect(document.documentElement.style.getPropertyValue('--rm-line-height')).toBe(String(lineHeight))
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

it('缺省或无效字体统一使用 Maple，保留用户已有的显式选择', () => {
  expect(sanitizeDisplaySettings({})).toMatchObject({ textFont: 'maple', codeFont: 'maple' })
  expect(sanitizeDisplaySettings({ textFont: 'unknown', codeFont: 'unknown' })).toMatchObject({ textFont: 'maple', codeFont: 'maple' })
  for (const textFont of ['sans', 'serif', 'system', 'maple']) expect(sanitizeDisplaySettings({ textFont }).textFont).toBe(textFont)
  for (const codeFont of ['jetbrains', 'system', 'maple']) expect(sanitizeDisplaySettings({ codeFont }).codeFont).toBe(codeFont)
  applyDisplaySettings(DISPLAY_DEFAULTS)
  expect(document.documentElement.style.getPropertyValue('--rm-font-editor')).toContain('Maple Mono Normal NL NF CN')
  expect(document.documentElement.style.getPropertyValue('--rm-font-mono')).toContain('Maple Mono Normal NL NF CN')
})
