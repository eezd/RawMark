// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../app/api'
import { allCommands } from '../app/commands'
import type { PluginAPI } from '../plugin-api'
import { pluginState, startPlugins, stopPlugins } from './host'

const { cause } = vi.hoisted(() => ({ cause: new Error('插件命令的原始原因') }))
vi.mock('/api/v1/plugins/fault/assets/rev/main.js', () => ({
  default: (sdk: PluginAPI) => sdk.addCommand({ id: 'fail', title: '失败命令', run() { throw cause } }),
}))
afterEach(() => { stopPlugins(); vi.restoreAllMocks() })

it('命令失败保留原始异常并清理注册，正常插件列表读取不受影响', async () => {
  vi.spyOn(api, 'plugins').mockResolvedValue([{ id: 'fault', name: '故障插件', version: '1', apiVersion: 1, revision: 'rev', enabled: true }])
  const notices: string[] = []
  startPlugins({ notice: (message) => notices.push(message), getActiveNote: () => null, openNote: async () => {}, writeNote: async () => ({ rev: 'r1' }) })
  await vi.waitFor(() => expect(pluginState.status.fault?.phase).toBe('active'))
  allCommands().find((command) => command.id === 'plugin:fault:fail')!.run()
  await vi.waitFor(() => expect(pluginState.status.fault?.cause).toBe(cause))
  expect(pluginState.status.fault?.phase).toBe('error')
  expect(allCommands().some((command) => command.id === 'plugin:fault:fail')).toBe(false)
  expect(notices.some((message) => message.includes('命令失败'))).toBe(true)
})
