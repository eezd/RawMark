import type { RouteRecordRaw } from 'vue-router'

export const constantRoutes: RouteRecordRaw[] = [
  { path: '/login', name: 'Login', component: () => import('@/pages/login/index.vue'), meta: { title: '登录', anonymous: true } },
  { path: '/setup', name: 'Setup', component: () => import('@/pages/login/index.vue'), meta: { title: '初始化', anonymous: true } },
  { path: '/403', name: 'Forbidden', component: () => import('@/pages/error/403.vue'), meta: { title: '访问受限' } },
  { path: '/:pathMatch(.*)*', name: 'NotFound', component: () => import('@/pages/error/404.vue'), meta: { title: '页面不存在' } },
]
export const dynamicRoutes: RouteRecordRaw[] = [
  { path: '/', name: 'Workspace', component: () => import('@/pages/workspace/index.vue'), meta: { title: 'RawMark', permissions: ['vault:read'] } },
]
