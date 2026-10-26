// @vitest-environment happy-dom
import type { VueWrapper } from '@vue/test-utils'
import { toasts } from '@@/utils/notifications'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { CanceledError } from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { pinia } from '@/pinia'
import { useSettingsStore } from '@/pinia/stores/settings'
import { useUserStore } from '@/pinia/stores/user'
import Sidebar from './components/Sidebar.vue'
import Workspace from './index.vue'
import { flushAll, readyToReload } from './workspace'

const preferences = useSettingsStore(pinia)

vi.mock('./workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace')>()
  return { ...actual, flushAll: vi.fn(), readyToReload: vi.fn(), startWorkspace: vi.fn(), stopWorkspace: vi.fn() }
})

const user = useUserStore(pinia)
let wrapper: VueWrapper | undefined
beforeEach(() => {
  user.setToken('rms_before')
  toasts.splice(0)
  vi.mocked(flushAll).mockResolvedValue(undefined)
  vi.mocked(readyToReload).mockReturnValue(true)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  user.setToken('')
})
async function mountWorkspace() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/login', component: { template: '<div />' } }] })
  await router.push('/')
  wrapper = shallowMount(Workspace, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return wrapper
}

it('正常退出先等待保存，再注销服务端会话', async () => {
  const logout = vi.spyOn(user, 'logout').mockResolvedValue(undefined)
  let finish!: () => void
  vi.mocked(flushAll).mockImplementationOnce(() => new Promise<void>((resolve) => {
    finish = resolve
  }))
  const component = await mountWorkspace()
  component.findComponent(Sidebar).vm.$emit('logout')
  expect(logout).not.toHaveBeenCalled()
  finish()
  await flushPromises()
  expect(logout).toHaveBeenCalledOnce()
})

it('等待保存期间切换会话，旧退出操作不能注销新身份', async () => {
  const logout = vi.spyOn(user, 'logout').mockResolvedValue(undefined)
  let finish!: () => void
  vi.mocked(flushAll).mockImplementationOnce(() => new Promise<void>((resolve) => {
    finish = resolve
  }))
  const component = await mountWorkspace()
  component.findComponent(Sidebar).vm.$emit('logout')
  user.setToken('rms_after')
  finish()
  await flushPromises()
  expect(logout).not.toHaveBeenCalled()
  expect(user.token).toBe('rms_after')
  expect(toasts).toHaveLength(0)
})

it('侧栏拖动期间切换会话，旧手势不能保存新身份的设置', async () => {
  const save = vi.spyOn(preferences, 'updateSettings').mockResolvedValue(undefined)
  const component = await mountWorkspace()
  const handle = component.get('.rm-sidebar-resize')
  Object.assign(handle.element, { setPointerCapture: vi.fn() })
  await handle.trigger('pointerdown', { clientX: 100, pointerId: 1 })
  await handle.trigger('pointermove', { clientX: 140, pointerId: 1 })
  user.setToken('rms_after')
  await handle.trigger('pointerup', { pointerId: 1 })
  expect(save).not.toHaveBeenCalled()
})

it('同一会话的侧栏拖动正常保存宽度', async () => {
  const save = vi.spyOn(preferences, 'updateSettings').mockResolvedValue(undefined)
  const component = await mountWorkspace()
  const handle = component.get('.rm-sidebar-resize')
  Object.assign(handle.element, { setPointerCapture: vi.fn() })
  await handle.trigger('pointerdown', { clientX: 100, pointerId: 1 })
  await handle.trigger('pointermove', { clientX: 140, pointerId: 1 })
  await handle.trigger('pointerup', { pointerId: 1 })
  expect(save).toHaveBeenCalledExactlyOnceWith({ sidebarWidth: preferences.settings.sidebarWidth + 40 })
})

it('侧栏设置请求因会话切换取消时不提示保存失败', async () => {
  let reject!: (error: Error) => void
  vi.spyOn(preferences, 'updateSettings').mockImplementationOnce(() => new Promise<void>((_, fail) => {
    reject = fail
  }))
  const component = await mountWorkspace()
  const handle = component.get('.rm-sidebar-resize')
  Object.assign(handle.element, { setPointerCapture: vi.fn() })
  await handle.trigger('pointerdown', { clientX: 100, pointerId: 1 })
  await handle.trigger('pointermove', { clientX: 140, pointerId: 1 })
  await handle.trigger('pointerup', { pointerId: 1 })
  user.setToken('rms_after')
  reject(new CanceledError('会话已变化'))
  await flushPromises()
  expect(toasts).toHaveLength(0)
})
