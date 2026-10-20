import { afterEach, expect, it, vi } from 'vitest'
import { bundledLanguages } from 'shiki/langs'
import type { HighlightResponse } from './protocol'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('未知语言正常完成，语言加载失败返回错误并允许下一次明确请求恢复', async () => {
  const replies = new Map<number, HighlightResponse>()
  const worker = new class extends EventTarget {
    postMessage(response: HighlightResponse) { replies.set(response.id, response) }
  }()
  vi.stubGlobal('self', worker)
  await import('./worker')
  for (const [id, lang] of ['unknown-language', 'constructor', '__proto__'].entries()) {
    worker.dispatchEvent(new MessageEvent('message', { data: { id, lang, code: 'text' } }))
    await vi.waitFor(() => expect(replies.get(id)).toEqual({ id, tokens: null }))
  }
  const cause = new Error('语言资源加载失败')
  const load = vi.spyOn(bundledLanguages, 'python').mockRejectedValueOnce(cause)
  worker.dispatchEvent(new MessageEvent('message', { data: { id: 10, lang: 'python', code: 'print(1)' } }))
  await vi.waitFor(() => expect(replies.has(10)).toBe(true))
  const failure = replies.get(10)!
  expect('error' in failure && failure.error.cause).toBe(cause)
  load.mockRestore()
  worker.dispatchEvent(new MessageEvent('message', { data: { id: 11, lang: 'python', code: 'print(1)' } }))
  await vi.waitFor(() => expect(replies.has(11)).toBe(true))
  const success = replies.get(11)!
  expect('tokens' in success && success.tokens?.length).toBeGreaterThan(0)
})
