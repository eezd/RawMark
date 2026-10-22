import { afterEach, expect, it, vi } from 'vitest'
import type { HighlightResponse } from './protocol'

afterEach(() => vi.unstubAllGlobals())

it('编辑器与分享页共用的 Worker 返回 GitHub Dark 原始配色', async () => {
  let reply: HighlightResponse | undefined
  const worker = new class extends EventTarget {
    postMessage(response: HighlightResponse) { reply = response }
  }()
  vi.stubGlobal('self', worker)
  await import('./worker')
  const code = 'const value = "hello" // comment'
  worker.dispatchEvent(new MessageEvent('message', { data: { id: 1, lang: 'javascript', code } }))
  await vi.waitFor(() => expect(reply).toBeDefined())
  if (!reply || !('tokens' in reply) || !reply.tokens) throw new Error('高亮 Worker 未返回颜色')
  const colors = new Map<string | number, string | number>()
  for (let i = 0; i < reply.tokens.length; i += 4) colors.set(reply.tokens[i], reply.tokens[i + 2])
  expect(colors.get(0)).toBe('#F97583')
  expect(colors.get(code.indexOf('"hello"'))).toBe('#9ECBFF')
  expect(colors.get(code.indexOf('//'))).toBe('#6A737D')
})
