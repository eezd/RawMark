import { shallowRef } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import { registerNavigationGuard } from './guard'
import { constantRoutes } from './routes'

export const router = createRouter({ history: createWebHistory(), routes: constantRoutes })
export const navigationError = shallowRef<{ message: string, path: string }>()
router.onError((error, to) => {
  navigationError.value = { message: error.message, path: to.fullPath }
})
router.afterEach(() => {
  navigationError.value = undefined
})
registerNavigationGuard(router)
