// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { typoraKeys } from './typora-keys'

describe('typora 默认快捷键', () => {
  it.each([false, true])('平台 mac=%s：标题、侧栏及无对应命令', (mac) => {
    expect(typoraKeys('editor.heading3', mac)).toEqual(['Mod+3'])
    expect(typoraKeys('view.sidebar', mac)).toEqual(['Mod+Shift+L'])
    for (const id of ['app.search', 'app.commandPalette', 'folder.new', 'editor.highlight', 'editor.task', 'plugin:test:command']) expect(typoraKeys(id, mac)).toEqual([])
  })
  it('平台差异遵循 Typora', () => {
    expect(typoraKeys('app.quickOpen', false)).toEqual(['Mod+P'])
    expect(typoraKeys('app.quickOpen', true)).toEqual(['Mod+Shift+O'])
    expect(typoraKeys('editor.redo', false)).toEqual(['Ctrl+Y'])
    expect(typoraKeys('editor.redo', true)).toEqual(['Mod+Shift+Z'])
    expect(typoraKeys('editor.strike', false)).toEqual(['Alt+Shift+5'])
    expect(typoraKeys('editor.strike', true)).toEqual(['Ctrl+Shift+`'])
    expect(typoraKeys('note.insertImage', true)).toEqual(['Mod+Ctrl+I'])
  })
  it.each(['MacIntel', 'Win32'])('%s 的默认组合没有物理冲突，Shift 标点可匹配并录入', async (platform) => {
    vi.stubGlobal('navigator', { platform })
    vi.resetModules()
    try {
      const { typoraKeys } = await import('./typora-keys')
      const { physicalKeys, matchKeys, recordedKeys } = await import('./keys')
      const { editorCommands } = await import('@/pages/workspace/editor/shortcuts')
      const ids = [...editorCommands.map(c => c.id), 'note.new', 'note.save', 'tab.close', 'app.settings', 'view.sidebar', 'view.source', 'view.focus', 'app.quickOpen', 'view.outline', 'note.insertImage']
      const keys = ids.flatMap(id => typoraKeys(id).map(physicalKeys))
      expect(new Set(keys).size).toBe(keys.length)
      const mac = platform === 'MacIntel'
      const event = new KeyboardEvent('keydown', { key: '~', code: 'Backquote', ctrlKey: !mac, metaKey: mac, shiftKey: true })
      expect(matchKeys(event, 'Mod+Shift+`')).toBe(true)
      expect(recordedKeys(event)).toBe('Mod+Shift+`')
      if (mac) {
        const option = new KeyboardEvent('keydown', { key: 'œ', code: 'KeyQ', metaKey: true, altKey: true })
        expect(matchKeys(option, 'Mod+Alt+Q')).toBe(true)
        expect(recordedKeys(option)).toBe('Mod+Alt+Q')
      }
      if (!mac) expect(matchKeys(new KeyboardEvent('keydown', { key: '{', code: 'BracketLeft', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+[')).toBe(true)
    } finally {
      vi.unstubAllGlobals(); vi.resetModules()
    }
  })
})
