import { vaultApi } from '@@/apis/vault'
import { toasts } from '@@/utils/notifications'
import { isCancel } from 'axios'
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { pinia } from '@/pinia'
import { usePermissionStore } from '@/pinia/stores/permission'
import { useUserStore } from '@/pinia/stores/user'
import { ApiError, requestJSON, requestRaw } from './axios'

const user = useUserStore(pinia)
const permission = usePermissionStore(pinia)
const payload = (data: unknown, status = 200, code = 0, message = '成功') => new Response(JSON.stringify({ code, data, message }), { status, headers: { 'Content-Type': 'application/json' } })
beforeEach(() => {
  user.setToken('rms_test'); toasts.splice(0)
})
afterEach(() => {
  vi.restoreAllMocks(); user.setToken('')
})

it('使用 Bearer 和统一 JSON，省略 Cookie 且禁止缓存', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(payload({ path: 'a.md' }))
  expect(await requestJSON('POST', '/test', { json: { a: 1 } })).toEqual({ path: 'a.md' })
  const req = fetch.mock.calls[0]![0] as Request
  expect(req.headers.get('Authorization')).toBe('Bearer rms_test')
  expect(req.credentials).toBe('omit')
  expect(fetch.mock.calls[0]![1]).toEqual(expect.objectContaining({ cache: 'no-store' }))
  expect(await req.text()).toBe('{"a":1}')
})
it('401 清理当前身份及动态路由，403 保留身份，错误只提示一次', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [] })
  permission.install(router, ['vault:read'])
  expect(router.hasRoute('Workspace')).toBe(true)
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(payload(null, 403, 40300, '权限不足')).mockResolvedValueOnce(payload(null, 401, 40100, '登录已失效'))
  await expect(requestJSON('GET', '/test')).rejects.toMatchObject({ status: 403, code: 40300 })
  expect(user.token).toBe('rms_test')
  expect(router.hasRoute('Workspace')).toBe(true)
  expect(toasts.map(item => item.text)).toEqual(['权限不足'])
  await expect(requestJSON('GET', '/test')).rejects.toMatchObject({ status: 401 })
  expect(user.token).toBe('')
  expect(router.hasRoute('Workspace')).toBe(false)
  expect(toasts.map(item => item.text)).toEqual(['权限不足', '登录已失效'])
})
it.each([200, 401, 403])('旧会话的 HTTP %s 响应不得覆盖或注销新会话', async (status) => {
  let finish!: (value: Response) => void
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
    finish = resolve
  }))
  const result = requestJSON('GET', '/slow').catch(error => error)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  user.setToken('rms_new')
  finish(payload({ old: true }, status, status === 200 ? 0 : status * 100))
  expect(isCancel(await result)).toBe(true)
  expect(user.token).toBe('rms_new')
  expect(toasts).toHaveLength(0)
})
it('身份恢复的旧响应也不能更改新会话权限', async () => {
  let finish!: (value: Response) => void
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
    finish = resolve
  }))
  const pending = user.getInfo().catch(error => error)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  user.setToken('rms_new')
  finish(payload({ permissions: ['instance:manage'], expiresAt: '2030-01-01T00:00:00Z' }))
  expect(isCancel(await pending)).toBe(true)
  expect(user.permissions).toEqual([])
  expect(user.isGotUserInfo).toBe(false)
})
it('身份恢复失败交给登录或路由页面展示，请求层不重复提示', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(payload(null, 503, 50300, '身份服务暂不可用'))
  await expect(user.getInfo()).rejects.toMatchObject({ status: 503, message: '身份服务暂不可用' })
  expect(user.token).toBe('rms_test')
  expect(toasts).toHaveLength(0)
})
it('业务失败明确拒绝，保留冲突版本，由调用方显示时请求层不重复提示', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(payload({ rev: 'current' }, 412, 41200, '版本冲突'))
  await expect(requestJSON('PUT', '/file', { errorOwner: 'caller' })).rejects.toMatchObject({ status: 412, code: 41200, data: { rev: 'current' } })
  expect(toasts).toHaveLength(0)
})
it('拒绝旧 JSON 格式及 HTTP 成功中的业务失败，文件与204保留原语义', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"ok":true}')).mockResolvedValueOnce(payload(null, 200, 40900, '操作失败')).mockResolvedValueOnce(new Response('正文', { headers: { ETag: '"rev"' } })).mockResolvedValueOnce(new Response(null, { status: 204 }))
  await expect(requestJSON('GET', '/old')).rejects.toBeInstanceOf(ApiError)
  await expect(requestJSON('GET', '/business')).rejects.toMatchObject({ code: 40900 })
  const raw = await requestRaw('GET', '/raw/a.md')
  expect(await raw.text()).toBe('正文')
  expect(raw.headers.get('ETag')).toBe('"rev"')
  expect(await requestJSON('POST', '/auth/logout')).toBeNull()
})
it('服务端注销失败保留身份；成功才清除本地身份', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(payload(null, 500, 50000, '注销失败')).mockResolvedValueOnce(new Response(null, { status: 204 }))
  await expect(user.logout()).rejects.toMatchObject({ status: 500 })
  expect(user.token).toBe('rms_test')
  await user.logout()
  expect(user.token).toBe('')
})

it('读取笔记的原始响应解码期间切换会话，旧正文仍须拒绝', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('旧正文', { headers: { ETag: '"old-rev"' } }))
  let finish!: (content: string) => void
  vi.spyOn(Response.prototype, 'text').mockImplementation(() => new Promise((resolve) => {
    finish = resolve
  }))
  const pending = vaultApi.readFile('note.md').catch(error => error)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  user.setToken('rms_new')
  finish('旧正文')
  expect(isCancel(await pending)).toBe(true)
  expect(user.token).toBe('rms_new')
  expect(toasts).toHaveLength(0)
})
