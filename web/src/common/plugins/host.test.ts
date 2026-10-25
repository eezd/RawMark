import type { PluginAPI } from '@@/plugin-api'
import { pluginsApi } from '@@/apis/plugins'
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { settings } from '../../pinia/stores/settings'
import { allCommands, commandKeys } from '../utils/commands'
import { pluginState, startPlugins, stopPlugins } from './host'

const { cause } = vi.hoisted(() => ({ cause: new Error('插件命令的原始原因') }))
vi.mock('/api/v1/resources/test-plugin/plugin/plugins/fault/assets/rev/main.js', () => ({
  default: (sdk: PluginAPI) => sdk.addCommand({ id: 'fail', title: '失败命令', keys: ['Mod+B'], run() {
    throw cause
  } }),
}))
afterEach(() => {
  stopPlugins(); vi.restoreAllMocks()
})

it('命令失败保留原始异常并清理注册，正常插件列表读取不受影响', async () => {
  vi.spyOn(pluginsApi, 'plugins').mockResolvedValue([{ id: 'fault', name: '故障插件', version: '1', apiVersion: 1, revision: 'rev', enabled: true }])
  const notices: string[] = []
  startPlugins({ notice: message => notices.push(message), getActiveNote: () => null, openNote: async () => {}, writeNote: async () => ({ rev: 'r1' }) })
  await vi.waitFor(() => expect(pluginState.status.fault?.phase).toBe('active'))
  const command = allCommands().find(command => command.id === 'plugin:fault:fail')!
  expect(commandKeys(command)).toEqual([])
  settings.shortcuts[command.id] = ['Mod+Alt+F']
  expect(commandKeys(command)).toEqual(['Mod+Alt+F'])
  delete settings.shortcuts[command.id]
  command.run()
  await vi.waitFor(() => expect(pluginState.status.fault?.cause).toBe(cause))
  expect(pluginState.status.fault?.phase).toBe('error')
  expect(allCommands().some(command => command.id === 'plugin:fault:fail')).toBe(false)
  expect(notices.some(message => message.includes('命令失败'))).toBe(true)
})

vi.mock('@@/apis/auth/resources', () => ({
  prepareResources: async () => {},
  imageResourceRoot: () => '/api/v1/resources/test-images/images/',
  fontResourceRoot: () => '/api/v1/resources/test-fonts/fonts/',
  pluginResourceURL: async (id: string, revision: string) => `/api/v1/resources/test-plugin/plugin/plugins/${id}/assets/${revision}/main.js`,
}))
