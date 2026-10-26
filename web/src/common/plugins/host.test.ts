import type { PluginsResponseData } from '@@/apis/plugins/type'
import type { PluginAPI } from '@@/plugin-api'
import * as pluginsApi from '@@/apis/plugins'
// @vitest-environment happy-dom
import { CanceledError, isCancel } from 'axios'
import { afterEach, expect, it, vi } from 'vitest'

import { pinia } from '@/pinia'
import { useSettingsStore } from '@/pinia/stores/settings'
import { apiSuccess } from '../../../tests/api-response'
import { allCommands, commandKeys } from '../utils/commands'
import { pluginState, refreshPlugins, retryPlugin, startPlugins, stopPlugins } from './host'

const { settings } = useSettingsStore(pinia)

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
  const list = vi.spyOn(pluginsApi, 'getPluginsApi').mockResolvedValue(apiSuccess({ plugins: [{ id: 'fault', name: '故障插件', version: '1', apiVersion: 1, revision: 'rev', enabled: true }] }))
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
  expect(notices.some(message => message.includes('Command failed'))).toBe(true)
  list.mockClear()
  await retryPlugin('fault')
  await vi.waitFor(() => expect(pluginState.status.fault?.phase).toBe('active'))
  expect(list).toHaveBeenCalledOnce()
})

it('交互刷新失败保留原因并 reject，不从宿主重复通知', async () => {
  const list = vi.spyOn(pluginsApi, 'getPluginsApi').mockResolvedValue(apiSuccess({ plugins: [] }))
  const notice = vi.fn()
  startPlugins({ notice, getActiveNote: () => null, openNote: async () => {}, writeNote: async () => ({ rev: 'r1' }) })
  await vi.waitFor(() => expect(pluginState.error).toBe(''))
  const failure = new Error('插件磁盘不可读')
  list.mockRejectedValueOnce(failure)
  await expect(refreshPlugins()).rejects.toBe(failure)
  expect(pluginState.errorCause).toBe(failure)
  expect(pluginState.error).toContain(failure.message)
  expect(notice).not.toHaveBeenCalled()
})

it('启动失败由入口通知一次，取消刷新不产生故障状态', async () => {
  const list = vi.spyOn(pluginsApi, 'getPluginsApi').mockRejectedValueOnce(new Error('启动读取失败'))
  const notice = vi.fn()
  startPlugins({ notice, getActiveNote: () => null, openNote: async () => {}, writeNote: async () => ({ rev: 'r1' }) })
  await vi.waitFor(() => expect(notice).toHaveBeenCalledOnce())
  list.mockResolvedValueOnce(apiSuccess({ plugins: [] }))
  await refreshPlugins()
  list.mockRejectedValueOnce(new CanceledError('Session changed'))
  await expect(refreshPlugins()).rejects.toSatisfy(isCancel)
  expect(pluginState.error).toBe('')
  expect(notice).toHaveBeenCalledOnce()
})

it('旧宿主刷新即使最后到达，也必须按取消拒绝且不覆盖新宿主', async () => {
  let finish!: (response: PluginsResponseData) => void
  const list = vi.spyOn(pluginsApi, 'getPluginsApi').mockResolvedValue(apiSuccess({ plugins: [] }))
  const notice = vi.fn()
  const adapter = { notice, getActiveNote: () => null, openNote: async () => {}, writeNote: async () => ({ rev: 'r1' }) }
  startPlugins(adapter)
  await vi.waitFor(() => expect(pluginState.error).toBe(''))
  list.mockImplementationOnce(() => new Promise((resolve) => {
    finish = resolve
  }))
  const old = refreshPlugins()
  const canceled = expect(old).rejects.toSatisfy(isCancel)
  stopPlugins()
  startPlugins(adapter)
  await refreshPlugins()
  finish(apiSuccess({ plugins: [{ id: 'old', name: '旧插件', version: '1', apiVersion: 1, revision: 'rev', enabled: false }] }))
  await canceled
  expect(pluginState.installed).toEqual([])
  expect(notice).not.toHaveBeenCalled()
})

it('旧启动已失败但通知尚未执行时，切换宿主也不能向新页面提示', async () => {
  vi.spyOn(pluginsApi, 'getPluginsApi').mockResolvedValue(apiSuccess({ plugins: [] })).mockRejectedValueOnce(new Error('旧启动失败'))
  const oldNotice = vi.fn()
  const newNotice = vi.fn()
  const adapter = { getActiveNote: () => null, openNote: async () => {}, writeNote: async () => ({ rev: 'r1' }) }
  startPlugins({ ...adapter, notice: oldNotice })
  await Promise.resolve()
  expect(pluginState.error).toContain('旧启动失败')
  stopPlugins()
  startPlugins({ ...adapter, notice: newNotice })
  await vi.waitFor(() => expect(pluginState.error).toBe(''))
  expect(oldNotice).not.toHaveBeenCalled()
  expect(newNotice).not.toHaveBeenCalled()
})

vi.mock('@@/utils/resource-tickets', () => ({
  prepareResources: async () => {},
  imageResourceRoot: () => '/api/v1/resources/test-images/images/',
  fontResourceRoot: () => '/api/v1/resources/test-fonts/fonts/',
  pluginResourceURL: async (id: string, revision: string) => `/api/v1/resources/test-plugin/plugin/plugins/${id}/assets/${revision}/main.js`,
}))
