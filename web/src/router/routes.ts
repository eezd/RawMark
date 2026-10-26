import type { RouteRecordRaw } from 'vue-router'

export const constantRoutes: RouteRecordRaw[] = [
  { path: '/login', name: 'Login', component: () => import('@/pages/login/index.vue'), meta: { titleKey: 'common.sign_in_1e2df9', anonymous: true } },
  { path: '/setup', name: 'Setup', component: () => import('@/pages/login/index.vue'), meta: { titleKey: 'common.setup_65622e', anonymous: true } },
  { path: '/403', name: 'Forbidden', component: () => import('@/pages/error/403.vue'), meta: { titleKey: 'common.access_denied_25fb07' } },
  { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('@/pages/error/404.vue'), meta: { titleKey: 'common.page_not_found_e75737' } },
]
export const dynamicRoutes: RouteRecordRaw[] = [
  { path: '/', name: 'Workspace', component: () => import('@/pages/workspace/index.vue'), meta: { title: 'RawMark', permissions: ['vault:read'] } },
]
