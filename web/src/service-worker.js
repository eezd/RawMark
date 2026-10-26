const CACHE = 'rawmark-shell-__VERSION__'
const FILES = __PRECACHE__
const paths = new Set(FILES)

globalThis.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    // Download in batches instead of requesting hundreds of syntax packages and fonts concurrently.
    for (let i = 0; i < FILES.length; i += 16) {
      await cache.addAll(FILES.slice(i, i + 16).map(url => new Request(url, { cache: 'reload' })))
    }
  })())
})

function clientUsesCurrentShell(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => {
      channel.port1.close(); resolve(false)
    }, 2000)
    channel.port1.onmessage = (event) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(paths.has(event.data))
    }
    client.postMessage('SHELL_ENTRY', [channel.port2])
  })
}

async function cleanCaches() {
  // Installing versions use independent caches too; old workers must not delete them as obsolete resources.
  if (globalThis.registration.installing || globalThis.registration.waiting) return
  const clients = await globalThis.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (!(await Promise.all(clients.map(clientUsesCurrentShell))).every(Boolean)) return
  for (const name of await caches.keys()) {
    if (globalThis.registration.installing || globalThis.registration.waiting) return
    if (name.startsWith('rawmark-shell-') && name !== CACHE) await caches.delete(name)
  }
}

globalThis.addEventListener('activate', (event) => {
  event.waitUntil(cleanCaches())
})

// Activation changes every page's controller, but only the page requesting the update refreshes itself.
globalThis.addEventListener('message', (event) => {
  if (event.data === 'ACTIVATE') event.waitUntil(globalThis.skipWaiting())
  if (event.data === 'CLEANUP') event.waitUntil(cleanCaches())
})

globalThis.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== globalThis.location.origin) return
  // Match only build assets and application entry points; never cache APIs, note images, or plugins.
  const entry = request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')
  if (!entry && !paths.has(url.pathname) && !url.pathname.startsWith('/assets/')) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const cached = await cache.match(entry ? '/index.html' : url.pathname)
    if (cached) return cached
    // Unrefreshed old tabs load old syntax packages and fonts by their original hashes.
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
