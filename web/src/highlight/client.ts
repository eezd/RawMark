import type { HighlightRequest, HighlightResponse, TokenRun } from './protocol'
import HighlightWorker from './worker?worker'

export type { TokenRun }

const CACHE_LIMIT = 500

let worker: Worker | undefined
let nextId = 1
const pending = new Map<number, { resolve: (tokens: TokenRun | null) => void; reject: (reason: unknown) => void }>()
// 以"语言 + 代码"为键缓存结果；Map 保持插入顺序，超限时淘汰最早的条目
const cache = new Map<string, TokenRun | null>()

function getWorker(): Worker {
  if (!worker) {
    worker = new HighlightWorker()
    worker.addEventListener('message', (e: MessageEvent<HighlightResponse>) => {
      const request = pending.get(e.data.id)
      pending.delete(e.data.id)
      if ('error' in e.data) request?.reject(e.data.error)
      else request?.resolve(e.data.tokens)
    })
    worker.addEventListener('error', (event) => {
      const error = new Error('高亮 Worker 运行失败', { cause: event.error ?? event.message })
      for (const request of pending.values()) request.reject(error)
      pending.clear()
      worker?.terminate()
      worker = undefined
    })
  }
  return worker
}

export function cachedTokens(lang: string, code: string): TokenRun | null | undefined {
  return cache.get(lang + '\0' + code)
}

export async function requestTokens(lang: string, code: string): Promise<TokenRun | null> {
  const key = lang + '\0' + code
  if (cache.has(key)) return Promise.resolve(cache.get(key)!)
  const id = nextId++
  const req: HighlightRequest = { id, lang, code }
  const target = getWorker()
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (tokens) => {
        cache.set(key, tokens)
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
        resolve(tokens)
      },
      reject,
    })
    try { target.postMessage(req) } catch (error) { pending.delete(id); reject(error) }
  })
}
