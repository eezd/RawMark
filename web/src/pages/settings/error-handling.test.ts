// @vitest-environment happy-dom
import type { VueWrapper } from '@vue/test-utils'
import * as maintenanceApi from '@@/apis/maintenance'
import * as plugins from '@@/plugins/host'
import { confirmAction } from '@@/utils/confirm'
import { toasts } from '@@/utils/notifications'
import { flushPromises, mount } from '@vue/test-utils'
import { CanceledError } from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import { apiSuccess } from '../../../tests/api-response'
import MaintenancePanel from './components/MaintenancePanel.vue'
import PluginsPanel from './components/PluginsPanel.vue'

const settings = vi.hoisted(() => ({ flushSettings: vi.fn(), loadSettings: vi.fn(), reloadTheme: vi.fn() }))
vi.mock('@/pinia/stores/settings', () => ({ useSettingsStore: () => settings }))
vi.mock('@@/plugins/host', () => ({
  refreshPlugins: vi.fn(),
  retryPlugin: vi.fn(),
  pluginState: { installed: [], status: {}, error: '' },
}))
vi.mock('@@/utils/confirm', () => ({ confirmAction: vi.fn() }))

const user = useUserStore(pinia)
const button = defineComponent({ template: '<button><slot /></button>' })
const global = { plugins: [pinia], stubs: { ElButton: button, ElTable: true } }
let wrapper: VueWrapper
beforeEach(() => {
  user.setToken('rms_settings')
  toasts.splice(0)
  vi.mocked(plugins.refreshPlugins).mockResolvedValue(undefined)
  vi.mocked(confirmAction).mockResolvedValue(true)
  settings.flushSettings.mockResolvedValue(undefined)
  settings.loadSettings.mockResolvedValue(undefined)
  settings.reloadTheme.mockResolvedValue(undefined)
  vi.spyOn(maintenanceApi, 'getMaintenanceStatusApi').mockResolvedValue(apiSuccess({ busy: false, operation: '', error: '', finishedAt: 0 }))
})
afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  user.setToken('')
})

it('手动插件刷新只请求一次，失败在当前面板保留原因', async () => {
  wrapper = mount(PluginsPanel, { global })
  await flushPromises()
  vi.mocked(plugins.refreshPlugins).mockClear().mockRejectedValueOnce(new Error('插件文件读取失败'))
  await wrapper.findAll('button').find(item => item.text() === 'Refresh list')!.trigger('click')
  await flushPromises()
  expect(plugins.refreshPlugins).toHaveBeenCalledOnce()
  expect(wrapper.findAll('.rm-auth-error')).toHaveLength(1)
  expect(wrapper.get('.rm-auth-error').text()).toContain('插件文件读取失败')
  expect(toasts).toHaveLength(0)
})

it('重置已成功但插件同步失败时，说明已完成的操作，不显示完整成功', async () => {
  const reset = vi.spyOn(maintenanceApi, 'resetSettingsApi').mockResolvedValue(apiSuccess({ ok: true }))
  wrapper = mount(MaintenancePanel, { props: { prepareMaintenance: async () => {} }, global })
  await flushPromises()
  vi.mocked(plugins.refreshPlugins).mockRejectedValueOnce(new Error('插件服务暂时不可用'))
  await wrapper.get('#rm-setting-settings-reset button').trigger('click')
  await flushPromises()
  expect(reset).toHaveBeenCalledOnce()
  expect(wrapper.get('[role="alert"]').text()).toContain('Settings reset. Previous settings backed up, but synchronization failed: 插件服务暂时不可用')
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
})

it('设置重置后的同步被会话切换取消时不提示失败', async () => {
  vi.spyOn(maintenanceApi, 'resetSettingsApi').mockResolvedValue(apiSuccess({ ok: true }))
  wrapper = mount(MaintenancePanel, { props: { prepareMaintenance: async () => {} }, global })
  await flushPromises()
  vi.mocked(plugins.refreshPlugins).mockRejectedValueOnce(new CanceledError('Session changed'))
  await wrapper.get('#rm-setting-settings-reset button').trigger('click')
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
  expect(toasts).toHaveLength(0)
})

it('同步阶段切换会话后，不继续为新会话刷新旧操作的插件或显示成功', async () => {
  vi.spyOn(maintenanceApi, 'resetSettingsApi').mockResolvedValue(apiSuccess({ ok: true }))
  settings.reloadTheme.mockImplementationOnce(async () => {
    user.setToken('rms_new_settings')
  })
  wrapper = mount(MaintenancePanel, { props: { prepareMaintenance: async () => {} }, global })
  await flushPromises()
  await wrapper.get('#rm-setting-settings-reset button').trigger('click')
  await flushPromises()
  expect(plugins.refreshPlugins).not.toHaveBeenCalled()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
})

it('设置导入已提交但同步失败时保留完成信息，不取消已提交的上传', async () => {
  vi.spyOn(maintenanceApi, 'startBackupUploadApi').mockResolvedValue(apiSuccess({ id: 'settings-upload' }))
  vi.spyOn(maintenanceApi, 'uploadBackupChunkApi').mockResolvedValue(apiSuccess({ offset: 3 }))
  vi.spyOn(maintenanceApi, 'validateBackupApi').mockResolvedValue(apiSuccess({ kind: 'settings', createdAt: 1, entries: 1, size: 3 }))
  const imported = vi.spyOn(maintenanceApi, 'importSettingsApi').mockResolvedValue(apiSuccess({ ok: true }))
  const cancel = vi.spyOn(maintenanceApi, 'cancelBackupUploadApi')
  vi.mocked(plugins.refreshPlugins).mockRejectedValueOnce(new Error('插件列表读取失败'))
  wrapper = mount(MaintenancePanel, { props: { prepareMaintenance: async () => {} }, global })
  await flushPromises()
  const input = wrapper.get('#rm-setting-backup-settings input')
  Object.defineProperty(input.element, 'files', { value: [new File(['zip'], 'settings.zip')] })
  await input.trigger('change')
  await flushPromises()
  expect(imported).toHaveBeenCalledExactlyOnceWith('settings-upload')
  expect(wrapper.get('[role="alert"]').text()).toContain('Settings and resources imported. Previous settings backed up, but synchronization failed: 插件列表读取失败')
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
  expect(cancel).not.toHaveBeenCalled()
})
