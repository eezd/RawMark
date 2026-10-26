import { watchFontLoading } from '@@/appearance/font-loading'
import { registerPwa } from '@@/utils/pwa'
import { createApp, watch } from 'vue'
import { isNavigationFailure } from 'vue-router'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import { router } from '@/router'
import App from './App.vue'
import { i18n } from './i18n'
import 'element-plus/dist/index.css'
import '@@/appearance/base.css'
import '@@/assets/styles/app.css'
import '@@/assets/styles/element-plus.scss'
import 'virtual:uno.css'

watchFontLoading()
const app = createApp(App)
app.use(i18n).use(pinia).use(router)
const user = useUserStore(pinia)
window.addEventListener('storage', user.syncStorage)
watch(() => user.sessionVersion, () => {
  const token = user.token
  const current = router.currentRoute.value
  const target = token ? { path: current.path, query: current.query, hash: current.hash, force: true } : { path: '/login', query: { redirect: router.currentRoute.value.fullPath } }
  void router.replace(target).catch((error) => {
    if (!isNavigationFailure(error)) console.error('认证导航失败', error)
  })
})
// 即使身份恢复暂时失败，也挂载可重试的错误界面。
void router.isReady().catch(() => {}).finally(() => {
  app.mount('#app'); void registerPwa()
})
