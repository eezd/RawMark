import { createResourceTicketApi } from '@@/apis/auth'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'

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
    const request = Promise.all([createResourceTicketApi({ kind: 'images' }), createResourceTicketApi({ kind: 'fonts' })]).then(([images, fonts]) => {
      user.assertSession(current)
      imageRoot = images.data.url
      fontRoot = fonts.data.url
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
  return `${(await createResourceTicketApi({ kind: 'plugin', pluginId, revision })).data.url}main.js`
}
