import { ref, shallowRef } from 'vue'

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export const online = ref(navigator.onLine)
export const waitingWorker = shallowRef<ServiceWorker | null>(null)
export const installPrompt = shallowRef<InstallPrompt | null>(null)

window.addEventListener('online', () => (online.value = true))
window.addEventListener('offline', () => (online.value = false))

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  installPrompt.value = event as InstallPrompt
})
window.addEventListener('appinstalled', () => (installPrompt.value = null))

export async function installApp() {
  const prompt = installPrompt.value
  if (!prompt) return
  await prompt.prompt()
  installPrompt.value = null
}

export async function registerPwa() {
  // 开发服务器不注册，避免外壳缓存干扰热更新。
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    const checkWaiting = () => {
      if (registration.waiting) waitingWorker.value = registration.waiting
      else if (waitingWorker.value?.state === 'redundant') waitingWorker.value = null
    }
    const trackInstalling = () => {
      registration.installing?.addEventListener('statechange', checkWaiting)
      checkWaiting()
    }
    trackInstalling()
    registration.addEventListener('updatefound', trackInstalling)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // 其他标签页激活新版时，本页也保留手动更新入口。
      waitingWorker.value = navigator.serviceWorker.controller
    })
    const checkUpdate = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void registration.update().catch((err) => console.warn('检查应用更新失败', err))
      }
    }
    document.addEventListener('visibilitychange', checkUpdate)
    window.addEventListener('online', checkUpdate)
    // 新旧页面报告入口哈希，确认所有页面均已更新后才回收旧资源。
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data === 'SHELL_ENTRY') {
        const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]')!
        event.ports[0]!.postMessage(new URL(script.src).pathname)
      }
    })
    const ready = await navigator.serviceWorker.ready
    ready.active?.postMessage('CLEANUP')
  } catch (err) {
    console.warn('注册离线外壳失败', err)
  }
}
