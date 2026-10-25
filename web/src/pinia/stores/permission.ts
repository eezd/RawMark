import type { Router, RouteRecordRaw } from 'vue-router'
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { dynamicRoutes } from '@/router/routes'

export const usePermissionStore = defineStore('permission', () => {
  const routes = shallowRef<RouteRecordRaw[]>([])
  const installed = ref(false)
  let removeRoutes: (() => void)[] = []
  function resetRoutes() {
    for (const remove of removeRoutes) remove()
    removeRoutes = []
    routes.value = []
    installed.value = false
  }
  function install(router: Router, permissions: string[]) {
    resetRoutes()
    routes.value = dynamicRoutes.filter(route => route.meta?.permissions === undefined || route.meta.permissions.some(permission => permissions.includes(permission)))
    removeRoutes = routes.value.map(route => router.addRoute(route))
    installed.value = true
  }
  return { routes, installed, install, resetRoutes }
})
