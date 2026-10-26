import { getCurrentUserApi, logoutApi } from '@@/apis/auth'
import { t as translate } from '@@/i18n/runtime'

import { CanceledError } from 'axios'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { usePermissionStore } from './permission'

const TOKEN_KEY = 'rawmark.token'
export const useUserStore = defineStore('user', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) ?? '')
  const permissions = ref<string[]>([])
  const expiresAt = ref('')
  const isGotUserInfo = ref(false)
  const sessionVersion = ref(0)
  let controller = new AbortController()
  let infoRequest: Promise<void> | undefined
  const getSessionVersion = () => sessionVersion.value
  const getSessionSignal = () => controller.signal

  function replaceToken(value: string, persist = true) {
    sessionVersion.value++
    controller.abort()
    controller = new AbortController()
    infoRequest = undefined
    permissions.value = []
    expiresAt.value = ''
    isGotUserInfo.value = false
    usePermissionStore().resetRoutes()
    if (persist) {
      if (value) localStorage.setItem(TOKEN_KEY, value)
      else localStorage.removeItem(TOKEN_KEY)
    }
    token.value = value
  }
  function assertSession(version: number) {
    if (version !== sessionVersion.value) throw new CanceledError(translate('common.session_changed_073f28'))
  }
  function invalidate(version: number) {
    if (version === sessionVersion.value) replaceToken('')
  }
  function getInfo(): Promise<void> {
    if (infoRequest) return infoRequest
    const version = sessionVersion.value
    const pending = (async () => {
      const data = (await getCurrentUserApi()).data
      assertSession(version)
      if (!data || !Array.isArray(data.permissions)
        || data.permissions.some(value => typeof value !== 'string')
        || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))) {
        throw new Error(translate('common.invalid_identity_information_e69b1a'))
      }
      permissions.value = data.permissions
      expiresAt.value = data.expiresAt
      isGotUserInfo.value = true
    })()
    infoRequest = pending
    void pending.finally(() => {
      if (infoRequest === pending) infoRequest = undefined
    }).catch(() => { /* 失败由原请求调用方处理。 */ })
    return pending
  }
  async function logout() {
    const version = sessionVersion.value
    await logoutApi()
    assertSession(version)
    invalidate(version)
  }
  function syncStorage(event: StorageEvent) {
    if (event.key !== TOKEN_KEY && event.key !== null) return
    const value = localStorage.getItem(TOKEN_KEY) ?? ''
    if (value !== token.value) replaceToken(value, false)
  }
  return { token, permissions, expiresAt, isGotUserInfo, sessionVersion, getSessionVersion, getSessionSignal, assertSession, setToken: replaceToken, invalidate, getInfo, logout, syncStorage }
})
