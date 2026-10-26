import { t as translate } from '@@/i18n/runtime'
// Command registry: command-palette actions and global shortcuts originate here; plugins also add commands through registerCommand.
import { shallowReactive } from 'vue'
import { pinia } from '@/pinia'
import { useSettingsStore } from '@/pinia/stores/settings'
import { formatKeys, matchKeys, physicalKeys } from './keys'

const { settings } = useSettingsStore(pinia)

export { formatKeys, matchKeys } from './keys'

export interface Command {
  id: string
  title: string
  /** Shortcuts such as 'Mod+Shift+F' or 'F1'; Mod is Cmd on Mac and Ctrl elsewhere. The first binding is displayed. */
  keys?: string[]
  /** Returning false disables the command in both the palette and shortcut dispatch. */
  when?: () => boolean
  run: () => void
}

const commands = shallowReactive(new Map<string, Command>())

/** Register a command and return its disposer; later registrations replace earlier ones with the same id. */
export function registerCommand(cmd: Command): () => void {
  commands.set(cmd.id, cmd)
  return () => {
    if (commands.get(cmd.id) === cmd) commands.delete(cmd.id)
  }
}

/** All registered commands, including unavailable ones, for the shortcut overview. */
export function allCommands(): Command[] {
  const all = [...commands.values()]
  const plugins = all.filter(command => command.id.startsWith('plugin:'))
  // Dynamic enable/disable must not change shortcut priority; retain registration order within each plugin.
  plugins.sort((a, b) => {
    const left = a.id.split(':')[1]; const right = b.id.split(':')[1]
    return left < right ? -1 : left > right ? 1 : 0
  })
  return [...all.filter(command => !command.id.startsWith('plugin:')), ...plugins]
}

export function availableCommands(): Command[] {
  return allCommands().filter(c => c.when?.() ?? true)
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
  if (!command) throw new Error(translate('common.command_not_found_1cdb0c', { p0: id }))
  const keys = commandKeys(command)
  return command.title + (keys.length ? `（${keys.map(formatKeys).join(' / ')}）` : '')
}

export function shortcutConflict(id: string, keys: string[]): Command | undefined {
  return allCommands().find(command => command.id !== id && commandKeys(command).some(existing => keys.some(key => physicalKeys(existing) === physicalKeys(key))))
}

/** Dispatch global shortcuts, ignoring defaultPrevented keys already handled by editors and keys during IME composition. */
export function handleShortcut(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing || e.getModifierState('AltGraph') || (e.target instanceof Element && e.target.closest('[data-shortcut-recorder]'))) return
  for (const cmd of availableCommands()) {
    if (cmd.id.startsWith('editor.') && !(e.target instanceof Element && e.target.closest('.cm-content'))) continue
    if (commandKeys(cmd).some(k => matchKeys(e, k))) {
      e.preventDefault()
      // The capture phase already ran the command; prevent editors or dialogs from handling the same key again.
      e.stopPropagation()
      cmd.run()
      return
    }
  }
}
