// 命令注册表：命令面板列出的操作与全局快捷键都来自这里；插件也通过 registerCommand 添加命令
import { shallowReactive } from 'vue'

export interface Command {
  id: string
  title: string
  /** 快捷键，如 'Mod+Shift+F'、'F1'；Mod 在 Mac 上为 Cmd，其他平台为 Ctrl。第一个用于显示 */
  keys?: string[]
  /** 返回 false 时命令不可用：不在面板中列出，快捷键也不触发 */
  when?: () => boolean
  run: () => void
}

const commands = shallowReactive(new Map<string, Command>())

/** 注册命令，返回注销函数；id 重复时后注册的覆盖先注册的 */
export function registerCommand(cmd: Command): () => void {
  commands.set(cmd.id, cmd)
  return () => {
    if (commands.get(cmd.id) === cmd) commands.delete(cmd.id)
  }
}

/** 全部已注册的命令（含当前不可用的），用于快捷键一览 */
export function allCommands(): Command[] {
  return [...commands.values()]
}

export function availableCommands(): Command[] {
  return [...commands.values()].filter((c) => c.when?.() ?? true)
}

export function runCommand(id: string) {
  const cmd = commands.get(id)
  if (cmd && (cmd.when?.() ?? true)) cmd.run()
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

export function matchKeys(e: KeyboardEvent, keys: string): boolean {
  const parts = keys.split('+')
  const key = parts.pop()!.toLowerCase()
  return (
    e.key.toLowerCase() === key &&
    (isMac ? e.metaKey : e.ctrlKey) === parts.includes('Mod') &&
    e.shiftKey === parts.includes('Shift') &&
    e.altKey === parts.includes('Alt')
  )
}

export function formatKeys(keys: string): string {
  const parts = keys.split('+')
  if (isMac) return parts.map((p) => ({ Mod: '⌘', Shift: '⇧', Alt: '⌥' })[p] ?? p).join('')
  return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+')
}

/** 全局快捷键分发；编辑器等已处理的按键（defaultPrevented）和输入法组字中的按键不处理 */
export function handleShortcut(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return
  for (const cmd of availableCommands()) {
    if (cmd.keys?.some((k) => matchKeys(e, k))) {
      e.preventDefault()
      cmd.run()
      return
    }
  }
}
