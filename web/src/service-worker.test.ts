import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

function worker() {
  const handlers: Record<string, (event: { request: Request, waitUntil: (promise: Promise<unknown>) => void, respondWith: (promise: Promise<Response>) => void }) => void> = {}
  const cache = { addAll: vi.fn().mockResolvedValue(undefined), match: vi.fn<() => Promise<Response | undefined>>().mockResolvedValue(undefined), put: vi.fn().mockResolvedValue(undefined) }
  const fetch = vi.fn().mockResolvedValue(new Response('font'))
  const source = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8').replace('__VERSION__', 'test').replace('__PRECACHE__', JSON.stringify(['/index.html', '/assets/main.js', '/assets/regular.woff2', '/assets/bold.woff2']))
  runInNewContext(source, { URL, Request: class extends Request {
    constructor(url: string, options?: RequestInit) {
      super(new URL(url, 'https://test.invalid'), options)
    }
  }, fetch, caches: { open: async () => cache, keys: async () => [] }, globalThis: { location: { origin: 'https://test.invalid' }, addEventListener: (name: string, handler: (event: { request: Request, waitUntil: (promise: Promise<unknown>) => void, respondWith: (promise: Promise<Response>) => void }) => void) => {
    handlers[name] = handler
  } } })
  return { handlers, cache, fetch }
}
it('安装缓存外壳但不预下载字体', async () => {
  const { handlers, cache } = worker()
  let done!: Promise<unknown>
  handlers.install!({ request: new Request('https://test.invalid'), respondWith: vi.fn(), waitUntil: (promise: Promise<unknown>) => {
    done = promise
  } })
  await done
  expect(cache.addAll.mock.calls.flat(2).map((request: Request) => request.url)).toEqual(['https://test.invalid/index.html', 'https://test.invalid/assets/main.js'])
})
it('使用后缓存公开构建字体，缓存命中不再请求网络', async () => {
  const { handlers, cache, fetch } = worker()
  const pending: Promise<unknown>[] = []
  let response!: Promise<Response>
  const event = { request: new Request('https://test.invalid/assets/bold.woff2'), respondWith: (promise: Promise<Response>) => {
    response = promise
  }, waitUntil: (promise: Promise<unknown>) => pending.push(promise) }
  handlers.fetch!(event); expect((await response).status).toBe(200); await Promise.all(pending)
  expect(cache.put).toHaveBeenCalledOnce()
  cache.match.mockResolvedValue(new Response('cached'))
  handlers.fetch!(event); expect(await (await response).text()).toBe('cached')
  expect(fetch).toHaveBeenCalledOnce()
})
it('不缓存失败响应，不拦截私有字体票据', async () => {
  const { handlers, cache, fetch } = worker()
  fetch.mockResolvedValue(new Response('missing', { status: 404 }))
  let response!: Promise<Response>
  const respondWith = vi.fn((promise: Promise<Response>) => {
    response = promise
  })
  handlers.fetch!({ request: new Request('https://test.invalid/assets/regular.woff2'), respondWith, waitUntil: vi.fn() })
  expect((await response).status).toBe(404); expect(cache.put).not.toHaveBeenCalled()
  respondWith.mockClear()
  handlers.fetch!({ request: new Request('https://test.invalid/api/v1/resources/ticket/fonts/custom/file'), respondWith, waitUntil: vi.fn() })
  expect(respondWith).not.toHaveBeenCalled()
})
