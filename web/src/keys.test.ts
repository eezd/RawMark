// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { matchKeys, recordedKeys } from './keys'

describe('快捷键匹配与录入', () => {
  it('精确匹配 Ctrl+Alt 数字，允许 Alt 改变字符而不改变物理数字键', () => {
    const event = new KeyboardEvent('keydown', { key: '¡', code: 'Digit1', ctrlKey: true, altKey: true })
    expect(matchKeys(event, 'Ctrl+Alt+1')).toBe(true)
    expect(matchKeys(event, 'Ctrl+1')).toBe(false)
    expect(matchKeys(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, metaKey: true }), 'Ctrl+B')).toBe(false)
  })
  it('不会把单独的修饰键录成快捷键', () => {
    expect(recordedKeys(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))).toBeNull()
    expect(recordedKeys(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, shiftKey: true }))).toContain('Plus')
  })
})
