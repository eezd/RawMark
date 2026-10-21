// 应用、编辑器和快捷键录入共用同一套按键表示。
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const modifiers = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift']

export function normalizeKeys(value: string): string {
  const parts = value.split('+')
  const key = parts.pop()
  if (!key || parts.some((part) => !modifiers.includes(part)) || new Set(parts).size !== parts.length || modifiers.includes(key)) throw new Error('快捷键格式无效')
  return [...modifiers.filter((part) => parts.includes(part)), key.length === 1 ? key.toUpperCase() : key].join('+')
}

export function physicalKeys(value: string): string {
  return normalizeKeys(value.replace(/\bMod\b/g, isMac ? 'Meta' : 'Ctrl'))
}

export function matchKeys(event: KeyboardEvent, value: string): boolean {
  const parts = physicalKeys(value).split('+')
  const key = parts.pop()!
  const actual = event.key === ' ' ? 'Space' : event.key === '+' ? 'Plus' : event.key
  const digit = /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : null
  return (actual.toUpperCase() === key.toUpperCase() || digit === key) &&
    event.ctrlKey === parts.includes('Ctrl') && event.metaKey === parts.includes('Meta') &&
    event.altKey === parts.includes('Alt') && event.shiftKey === parts.includes('Shift')
}

export function recordedKeys(event: KeyboardEvent): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'Dead', 'Process', 'Unidentified'].includes(event.key) || event.isComposing) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push(isMac ? 'Ctrl' : 'Mod')
  if (event.metaKey) parts.push(isMac ? 'Mod' : 'Meta')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  const key = /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.key === ' ' ? 'Space' : event.key === '+' ? 'Plus' : event.key
  return normalizeKeys([...parts, key].join('+'))
}

export function formatKeys(value: string): string {
  return value.split('+').map((part) => ({ Mod: isMac ? '⌘' : 'Ctrl', Meta: isMac ? '⌘' : 'Win', Ctrl: isMac ? '⌃' : 'Ctrl', Alt: isMac ? '⌥' : 'Alt', Shift: isMac ? '⇧' : 'Shift', Space: '空格', Plus: '+' })[part] ?? part).join(isMac ? '' : '+')
}
