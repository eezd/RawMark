import { isMac } from './keys'

// https://support.typora.io/Shortcut-Keys/；仅为已有功能提供默认值。
export function typoraKeys(id: string, mac = isMac): string[] {
  if (/^editor\.heading[1-6]$/.test(id)) return [`Mod+${id.at(-1)}`]
  const common: Record<string, string[]> = {
    'note.new': ['Mod+N'], 'note.save': ['Mod+S'], 'tab.close': ['Mod+W'],
    'app.settings': ['Mod+,'], 'view.sidebar': ['Mod+Shift+L'],
    'view.source': ['Mod+/'], 'view.focus': ['F8'],
    'editor.bold': ['Mod+B'], 'editor.italic': ['Mod+I'], 'editor.underline': ['Mod+U'],
    'editor.link': ['Mod+K'], 'editor.code': ['Mod+Shift+`'],
    'editor.undo': ['Mod+Z'], 'editor.selectAll': ['Mod+A'],
    'editor.indent': ['Mod+[', 'Tab'],
    'editor.outdent': ['Mod+]', 'Shift+Tab'],
  }
  const platform: Record<string, string[]> = {
    'app.quickOpen': mac ? ['Mod+Shift+O'] : ['Mod+P'],
    'view.outline': mac ? ['Mod+Ctrl+1'] : ['Ctrl+Shift+1'],
    'note.insertImage': mac ? ['Mod+Ctrl+I'] : ['Ctrl+Shift+I'],
    'editor.redo': mac ? ['Mod+Shift+Z'] : ['Ctrl+Y'],
    'editor.strike': mac ? ['Ctrl+Shift+`'] : ['Alt+Shift+5'],
    'editor.quote': mac ? ['Mod+Alt+Q'] : ['Ctrl+Shift+Q'],
    'editor.ordered': mac ? ['Mod+Alt+O'] : ['Ctrl+Shift+['],
    'editor.bullet': mac ? ['Mod+Alt+U'] : ['Ctrl+Shift+]'],
  }
  return common[id] ?? platform[id] ?? []
}
