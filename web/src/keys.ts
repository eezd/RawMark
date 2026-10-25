// 应用、编辑器和快捷键录入共用同一套按键表示。
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const punctuation: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Backquote: '`' }
const modifiers = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift']

function physicalCharacter(event: KeyboardEvent): string | undefined {
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5)
  // macOS Option 会把 Q/O/U 等变成其他字符，快捷键仍按原物理字母匹配。
  if (isMac && event.altKey && /^Key[A-Z]$/.test(event.code)) return event.code.slice(3)
  return punctuation[event.code]
}

export function normalizeKeys(value: string): string {
  const parts = value.split('+')
  const key = parts.pop()
  if (!key || parts.some((part) => !modifiers.includes(part)) || new Set(parts).size !== parts.length || modifiers.includes(key)) throw new Error('快捷键格式无效')
  return [...modifiers.filter((part) => parts.includes(part)), key.length === 1 ? key.toUpperCase() : key].join('+')
}

export function physicalKeys(value: string): string {
  const parts = normalizeKeys(value).split('+').map((part) => part === 'Mod' ? isMac ? 'Meta' : 'Ctrl' : part)
  return normalizeKeys([...new Set(parts)].join('+'))
}

export function matchKeys(event: KeyboardEvent, value: string): boolean {
  const parts = physicalKeys(value).split('+')
  const key = parts.pop()!
  const actual = event.key === ' ' ? 'Space' : event.key === '+' ? 'Plus' : event.key
  return (actual.toUpperCase() === key.toUpperCase() || physicalCharacter(event) === key) &&
    event.ctrlKey === parts.includes('Ctrl') && event.metaKey === parts.includes('Meta') &&
    event.altKey === parts.includes('Alt') && event.shiftKey === parts.includes('Shift')
}

export function recordedKeys(event: KeyboardEvent): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'Dead', 'Process', 'Unidentified'].includes(event.key) || event.isComposing) return null
  const parts: string[] = []
  // 同时按下两种修饰键时保留物理组合，避免同步后 Mod 与另一键重合。
  if (event.ctrlKey) parts.push(isMac || event.metaKey ? 'Ctrl' : 'Mod')
  if (event.metaKey) parts.push(!isMac || event.ctrlKey ? 'Meta' : 'Mod')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  const key = physicalCharacter(event) ?? (event.key === ' ' ? 'Space' : event.key === '+' ? 'Plus' : event.key)
  return normalizeKeys([...parts, key].join('+'))
}

export function formatKeys(value: string): string {
  return value.split('+').map((part) => ({ Mod: isMac ? '⌘' : 'Ctrl', Meta: isMac ? '⌘' : 'Win', Ctrl: isMac ? '⌃' : 'Ctrl', Alt: isMac ? '⌥' : 'Alt', Shift: isMac ? '⇧' : 'Shift', Space: '空格', Plus: '+' })[part] ?? part).join(isMac ? '' : '+')
}
