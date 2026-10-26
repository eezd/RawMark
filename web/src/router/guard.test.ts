import * as authApi from '@@/apis/auth'
import { applyLocale } from '@@/i18n/runtime'
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { createMemoryHistory, createRouter } from 'vue-router'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import { apiSuccess } from '../../tests/api-response'
import { loginRedirect, registerNavigationGuard } from './guard'
import { constantRoutes } from './routes'

const user = useUserStore(pinia)
const identity = { permissions: ['vault:read', 'vault:write', 'instance:manage'], expiresAt: '2030-01-01T00:00:00Z' }
beforeEach(() => {
  applyLocale('en')
  user.setToken(''); vi.spyOn(authApi, 'getAuthStateApi').mockResolvedValue(apiSuccess({ setUp: true })); vi.spyOn(authApi, 'getCurrentUserApi').mockResolvedValue(apiSuccess(identity))
})
afterEach(() => {
  user.setToken(''); vi.restoreAllMocks()
})
function makeRouter() {
  const router = createRouter({ history: createMemoryHistory(), routes: constantRoutes })
  registerNavigationGuard(router)
  return router
}
it('匿名深链保留完整回跳地址，登录后恢复身份并注册路由', async () => {
  const router = makeRouter()
  await router.push('/?note=a#heading')
  expect(router.currentRoute.value.path).toBe('/login')
  expect(router.currentRoute.value.query.redirect).toBe('/?note=a#heading')
  user.setToken('rms_valid')
  // 登录组件已恢复身份时，守卫依然必须安装动态路由。
  await user.getInfo()
  await router.replace({ path: '/login', query: router.currentRoute.value.query, force: true })
  expect(router.currentRoute.value.fullPath).toBe('/?note=a#heading')
  expect(router.currentRoute.value.name).toBe('Workspace')
})
it('刷新时恢复后端身份；无权限进入403，保留Token', async () => {
  user.setToken('rms_valid')
  vi.mocked(authApi.getCurrentUserApi).mockResolvedValue(apiSuccess({ ...identity, permissions: [] }))
  const router = makeRouter()
  await router.push('/')
  expect(router.currentRoute.value.path).toBe('/403')
  expect(user.token).toBe('rms_valid')
})
it('未初始化进入设置密码页；匿名登录挑战无需虚构用户', async () => {
  vi.mocked(authApi.getAuthStateApi).mockResolvedValue(apiSuccess({ setUp: false }))
  const router = makeRouter()
  await router.push('/login')
  expect(router.currentRoute.value.path).toBe('/setup')
  expect(authApi.getCurrentUserApi).not.toHaveBeenCalled()
})
it('身份恢复的网络失败必须拒绝，不能伪装成匿名或成功', async () => {
  user.setToken('rms_valid')
  vi.mocked(authApi.getCurrentUserApi).mockRejectedValue(new Error('网络断开'))
  const router = makeRouter()
  router.onError(() => {})
  await expect(router.push('/')).rejects.toThrow('网络断开')
  expect(user.token).toBe('rms_valid')
  expect(user.isGotUserInfo).toBe(false)
})
it.each(['//evil.example', 'https://evil.example', '/\\evil.example', '/login', '/setup'])('拒绝外部及循环回跳 %s', (value) => {
  expect(loginRedirect(value)).toBe('/')
})

it('登录页语言切换同步标题，不依赖再次导航', async () => {
  const router = makeRouter()
  await router.push('/login')
  expect(document.title).toBe('Sign in')
  applyLocale('zh-CN')
  await nextTick()
  expect(document.title).toBe('登录')
})
