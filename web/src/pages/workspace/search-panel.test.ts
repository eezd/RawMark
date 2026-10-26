// @vitest-environment happy-dom
import type { SearchResponseData } from '@@/apis/search/type'
import type { VueWrapper } from '@vue/test-utils'
import * as searchApi from '@@/apis/search'
import { toasts } from '@@/utils/notifications'
import { flushPromises, mount } from '@vue/test-utils'
import { CanceledError } from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import { apiSuccess } from '../../../tests/api-response'
import SearchPanel from './components/SearchPanel.vue'

vi.mock('./workspace', () => ({ ws: { searchOpen: true, active: '' }, openAt: vi.fn() }))

const user = useUserStore(pinia)
let wrapper: VueWrapper
beforeEach(() => {
  vi.useFakeTimers()
  toasts.splice(0)
  user.setToken('rms_search')
  wrapper = mount(SearchPanel, { global: { plugins: [pinia] } })
})
afterEach(() => {
  wrapper.unmount()
  vi.restoreAllMocks()
  vi.useRealTimers()
  user.setToken('')
})

it('会话取消不提示，真实搜索失败保留原始原因', async () => {
  const search = vi.spyOn(searchApi, 'searchApi').mockRejectedValueOnce(new CanceledError('会话已变化'))
  await wrapper.get('input').setValue('旧查询')
  await vi.advanceTimersByTimeAsync(150)
  expect(toasts).toHaveLength(0)
  search.mockRejectedValueOnce(new Error('正在维护，请稍后重试'))
  await wrapper.get('input').setValue('新查询')
  await vi.advanceTimersByTimeAsync(150)
  expect(toasts.map(item => item.text)).toEqual(['正在维护，请稍后重试'])
})

it('组件卸载或会话切换后，等待中的搜索不再发送', async () => {
  const search = vi.spyOn(searchApi, 'searchApi')
  await wrapper.get('input').setValue('旧查询')
  user.setToken('rms_new_search')
  await vi.advanceTimersByTimeAsync(150)
  expect(search).not.toHaveBeenCalled()
  expect(toasts).toHaveLength(0)
  await wrapper.get('input').setValue('卸载查询')
  wrapper.unmount()
  await vi.advanceTimersByTimeAsync(150)
  expect(search).not.toHaveBeenCalled()
})

it('输入变化立即使旧结果失效，卸载后到达的错误不提示', async () => {
  let resolve!: (response: SearchResponseData) => void
  let reject!: (cause: Error) => void
  vi.spyOn(searchApi, 'searchApi').mockImplementationOnce(() => new Promise((done) => {
    resolve = done
  })).mockImplementationOnce(() => new Promise((_, fail) => {
    reject = fail
  }))
  await wrapper.get('input').setValue('旧查询')
  await vi.advanceTimersByTimeAsync(150)
  await wrapper.get('input').setValue('新查询')
  resolve(apiSuccess({ results: [{ path: '旧结果.md', line: 1, snippet: '旧内容' }] }))
  await flushPromises()
  expect(wrapper.findAll('.rm-search-item')).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(150)
  wrapper.unmount()
  reject(new Error('旧页面搜索失败'))
  await flushPromises()
  expect(toasts).toHaveLength(0)
})
