// 命令注册表：命令面板列出的操作与全局快捷键都来自这里；插件也通过 registerCommand 添加命令
import { shallowReactive } from 'vue'
import { settings } from './settings'
import { formatKeys, matchKeys, physicalKeys } from '../keys'
export { formatKeys, matchKeys } from '../keys'

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
  const all = [...commands.values()]
  const plugins = all.filter((command) => command.id.startsWith('plugin:'))
  // 动态启停不能改变快捷键优先级；同一插件内仍保留注册顺序。
  plugins.sort((a, b) => {
    const left = a.id.split(':')[1], right = b.id.split(':')[1]
    return left < right ? -1 : left > right ? 1 : 0
  })
  return [...all.filter((command) => !command.id.startsWith('plugin:')), ...plugins]
}

export function availableCommands(): Command[] {
  return allCommands().filter((c) => c.when?.() ?? true)
}

export function runCommand(id: string) {
  const cmd = commands.get(id)
  if (cmd && (cmd.when?.() ?? true)) cmd.run()
}

export function commandKeys(command: Command): string[] {
  return settings.shortcuts[command.id] ?? command.keys ?? []
}

export function commandTitle(id: string): string {
  const command = commands.get(id)
  if (!command) throw new Error('命令不存在：' + id)
  const keys = commandKeys(command)
  return command.title + (keys.length ? `（${keys.map(formatKeys).join(' / ')}）` : '')
}

export function shortcutConflict(id: string, keys: string[]): Command | undefined {
  return allCommands().find((command) => command.id !== id && commandKeys(command).some((existing) => keys.some((key) => physicalKeys(existing) === physicalKeys(key))))
}

/** 全局快捷键分发；编辑器等已处理的按键（defaultPrevented）和输入法组字中的按键不处理 */
export function handleShortcut(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || e.getModifierState('AltGraph') || (e.target instanceof Element && e.target.closest('[data-shortcut-recorder]'))) return
  for (const cmd of availableCommands()) {
    if (cmd.id.startsWith('editor.') && !(e.target instanceof Element && e.target.closest('.cm-content'))) continue
    if (commandKeys(cmd).some((k) => matchKeys(e, k))) {
      e.preventDefault()
      // 捕获阶段已执行命令，不再让编辑器或弹窗重复处理同一次按键。
      e.stopPropagation()
      cmd.run()
      return
    }
  }
}
