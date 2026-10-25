// @vitest-environment happy-dom
import type { VueWrapper } from '@vue/test-utils'
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import App from './App.vue'

vi.mock('@/router', () => ({ navigationError: undefined, router: {} }))

const user = useUserStore(pinia)
let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  user.setToken('')
})

it.each(['', 'rms_other'])('切换身份至 %s 时，不在旧路由上重新挂载未认证的业务页面', async (token) => {
  const started = vi.fn()
  const workspace = defineComponent({
    setup() {
      started()
      return () => h('div', { 'data-workspace': '' })
    },
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: workspace },
    { path: '/login', component: { template: '<div data-login />' }, meta: { anonymous: true } },
  ] })
  user.setToken('rms_current')
  user.isGotUserInfo = true
  await router.push('/')
  wrapper = mount(App, { global: { plugins: [pinia, router], stubs: { ElConfigProvider: { props: ['locale'], template: '<slot />' }, Toasts: true } } })
  expect(started).toHaveBeenCalledOnce()

  user.setToken(token)
  await nextTick()
  expect(started).toHaveBeenCalledOnce()
  expect(wrapper.find('[data-workspace]').exists()).toBe(false)

  if (token) {
    user.isGotUserInfo = true
    await nextTick()
    expect(started).toHaveBeenCalledTimes(2)
  } else {
    await router.push('/login')
    expect(wrapper.find('[data-login]').exists()).toBe(true)
  }
})
