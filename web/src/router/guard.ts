import type { Router } from 'vue-router'
import { getAuthStateApi } from '@@/apis/auth'
import { locale, t as translate } from '@@/i18n/runtime'
import { isCancel } from 'axios'

import { watch } from 'vue'
import { pinia } from '@/pinia'
import { usePermissionStore } from '@/pinia/stores/permission'
import { useUserStore } from '@/pinia/stores/user'

export function loginRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  const target = new URL(value, location.origin)
  return target.origin === location.origin && !['/login', '/setup'].includes(target.pathname) ? target.pathname + target.search + target.hash : '/'
}
export function registerNavigationGuard(router: Router) {
  router.beforeEach(async (to) => {
    const user = useUserStore(pinia)
    const version = user.getSessionVersion()
    if (!user.token) {
      let setUp: boolean
      try {
        ({ setUp } = (await getAuthStateApi()).data)
        user.assertSession(version)
      } catch (error) {
        if (isCancel(error)) return false
        throw error
      }
      const path = setUp ? '/login' : '/setup'
      if (to.path === path) return true
      return { path, query: { redirect: to.fullPath }, replace: true }
    }
    if (!user.isGotUserInfo) {
      try {
        await user.getInfo()
        user.assertSession(version)
      } catch (error) {
        if (isCancel(error)) return false
        if (!user.token) return { path: '/login', query: { redirect: to.fullPath }, replace: true }
        throw error
      }
    }
    const permission = usePermissionStore(pinia)
    if (!permission.installed) {
      permission.install(router, user.permissions)
      return { path: to.path, query: to.query, hash: to.hash, replace: true }
    }
    if (to.path === '/' && !router.hasRoute('Workspace')) return '/403'
    if (to.meta.permissions && !to.meta.permissions.some(value => user.permissions.includes(value))) return '/403'
    if (to.meta.anonymous) return loginRedirect(to.query.redirect)
    return true
  })
  function updateTitle() {
    const meta = router.currentRoute.value.meta
    document.title = typeof meta.titleKey === 'string' ? translate(meta.titleKey) : typeof meta.title === 'string' ? meta.title : 'RawMark'
  }
  watch(locale, updateTitle)
  router.afterEach(updateTitle)
}
