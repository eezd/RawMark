import type { HighlightRequest, HighlightResponse, TokenRun } from './protocol'
import HighlightWorker from './worker?worker'

export type { TokenRun }

const CACHE_LIMIT = 500

let worker: Worker | undefined
let nextId = 1
const pending = new Map<number, (tokens: TokenRun | null) => void>()
// 以"语言 + 代码"为键缓存结果；Map 保持插入顺序，超限时淘汰最早的条目
const cache = new Map<string, TokenRun | null>()

function getWorker(): Worker {
  if (!worker) {
    worker = new HighlightWorker()
    worker.addEventListener('message', (e: MessageEvent<HighlightResponse>) => {
      const resolve = pending.get(e.data.id)
      pending.delete(e.data.id)
      resolve?.(e.data.tokens)
    })
  }
  return worker
}

export function cachedTokens(lang: string, code: string): TokenRun | null | undefined {
  return cache.get(lang + '\0' + code)
}

export function requestTokens(lang: string, code: string): Promise<TokenRun | null> {
  const key = lang + '\0' + code
  if (cache.has(key)) return Promise.resolve(cache.get(key)!)
  const id = nextId++
  const req: HighlightRequest = { id, lang, code }
  return new Promise((resolve) => {
    pending.set(id, (tokens) => {
      cache.set(key, tokens)
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
      resolve(tokens)
    })
    getWorker().postMessage(req)
  })
}
