// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { HighlightRequest } from './protocol'
import { requestTokens } from './client'

const control = vi.hoisted(() => ({ startupError: undefined as Error | undefined, workers: [] as { dispatchEvent(event: Event): boolean; request?: HighlightRequest }[] }))
vi.mock('./worker?worker', () => ({
  default: class extends EventTarget {
    request?: HighlightRequest
    constructor() {
      super()
      if (control.startupError) throw control.startupError
      control.workers.push(this)
    }
    postMessage(request: HighlightRequest) { this.request = request }
    terminate() {}
  },
}))

it('启动和运行失败均结束请求，失败不会伪装成缓存结果且后续请求可恢复', async () => {
  const startupError = new Error('无法创建 Worker')
  control.startupError = startupError
  await expect(requestTokens('python', 'print(1)')).rejects.toBe(startupError)
  control.startupError = undefined
  const failed = requestTokens('python', 'print(1)')
  const error = new Error('语言加载失败')
  const worker = control.workers[0]!
  const rejected = expect(failed).rejects.toBe(error)
  worker.dispatchEvent(new MessageEvent('message', { data: { id: worker.request!.id, error } }))
  await rejected
  const interrupted = requestTokens('python', 'print(1)')
  const crashed = expect(interrupted).rejects.toMatchObject({ cause: error })
  worker.dispatchEvent(new ErrorEvent('error', { error }))
  await crashed
  const recovered = requestTokens('python', 'print(1)')
  const replacement = control.workers[1]!
  replacement.dispatchEvent(new MessageEvent('message', { data: { id: replacement.request!.id, tokens: [{ classes: 'hljs-title function_', content: ['print'] }] } }))
  await expect(recovered).resolves.toEqual([{ classes: 'hljs-title function_', content: ['print'] }])
})
