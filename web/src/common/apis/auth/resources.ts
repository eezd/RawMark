import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import { authApi } from './index'

let version = -1
let imageRoot = ''
let fontRoot = ''
let pending: Promise<void> | undefined
export async function prepareResources() {
  const user = useUserStore(pinia)
  const current = user.getSessionVersion()
  if (version !== current) {
    version = current; imageRoot = ''; fontRoot = ''; pending = undefined
  }
  if (imageRoot && fontRoot) return
  if (!pending) {
    const request = Promise.all([authApi.ticket({ kind: 'images' }), authApi.ticket({ kind: 'fonts' })]).then(([images, fonts]) => {
      user.assertSession(current)
      imageRoot = images.url
      fontRoot = fonts.url
    })
    pending = request
    void request.finally(() => {
      if (pending === request) pending = undefined
    }).catch(() => { /* 由等待初始化的调用方处理失败。 */ })
  }
  await pending
  user.assertSession(current)
}
export function imageResourceRoot(): string {
  if (!imageRoot || version !== useUserStore(pinia).getSessionVersion()) throw new Error('图片资源认证尚未就绪')
  return imageRoot
}
export function fontResourceRoot(): string {
  if (!fontRoot || version !== useUserStore(pinia).getSessionVersion()) throw new Error('字体资源认证尚未就绪')
  return fontRoot
}
export async function pluginResourceURL(pluginId: string, revision: string): Promise<string> {
  return `${(await authApi.ticket({ kind: 'plugin', pluginId, revision })).url}main.js`
}
