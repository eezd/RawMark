const CACHE = 'rawmark-shell-__VERSION__'
const FILES = __PRECACHE__
const paths = new Set(FILES)

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    // 逐批下载，避免同时请求数百个语法包和字体。
    for (let i = 0; i < FILES.length; i += 16) {
      await cache.addAll(FILES.slice(i, i + 16).map((url) => new Request(url, { cache: 'reload' })))
    }
  })())
})

function clientUsesCurrentShell(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => { channel.port1.close(); resolve(false) }, 2000)
    channel.port1.onmessage = (event) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(paths.has(event.data))
    }
    client.postMessage('SHELL_ENTRY', [channel.port2])
  })
}

async function cleanCaches() {
  // 安装中的新版本也使用独立缓存，旧 worker 不能把它当作过期资源删除。
  if (self.registration.installing || self.registration.waiting) return
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (!(await Promise.all(clients.map(clientUsesCurrentShell))).every(Boolean)) return
  for (const name of await caches.keys()) {
    if (self.registration.installing || self.registration.waiting) return
    if (name.startsWith('rawmark-shell-') && name !== CACHE) await caches.delete(name)
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(cleanCaches())
})

// 激活会更换所有页面的控制器，但只由点击更新的页面主动刷新。
self.addEventListener('message', (event) => {
  if (event.data === 'ACTIVATE') event.waitUntil(self.skipWaiting())
  if (event.data === 'CLEANUP') event.waitUntil(cleanCaches())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  // 只匹配构建产物与应用入口，不缓存 API、笔记图片或插件。
  const entry = request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')
  if (!entry && !paths.has(url.pathname) && !url.pathname.startsWith('/assets/')) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const cached = await cache.match(entry ? '/index.html' : url.pathname)
    if (cached) return cached
    // 旧标签页尚未刷新时，按原来的哈希加载旧语法包与字体。
    if (url.pathname.startsWith('/assets/')) {
      for (const name of await caches.keys()) {
        if (!name.startsWith('rawmark-shell-')) continue
        const previous = await (await caches.open(name)).match(url.pathname)
        if (previous) return previous
      }
    }
    return fetch(request)
  })())
})
