import type { AsyncCleanup, Awaitable, MountContext } from '@@/plugin-api'

// 每次挂载使用独立容器；超时或停用后的异步渲染只能修改已脱离页面的容器。
export function mountContent(
  parent: HTMLElement,
  mount: (context: MountContext) => Awaitable<void | AsyncCleanup>,
  fail: (error: unknown) => void,
): () => void {
  const controller = new AbortController()
  const container = document.createElement('div')
  parent.replaceChildren(container)
  let cleanup: void | AsyncCleanup
  let stopped = false
  let pending = true
  const runCleanup = (fn: AsyncCleanup) => {
    try {
      void Promise.resolve(fn()).catch(fail)
    } catch (error) {
      fail(error)
    }
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    controller.abort()
    container.remove()
    if (cleanup) runCleanup(cleanup)
    clearTimeout(timer)
  }
  const timer = setTimeout(() => {
    if (!pending || stopped) return
    stop()
    fail(new Error('插件视图渲染超过 10 秒'))
  }, 10_000)
  void Promise.resolve().then(() => {
    if (!stopped) return mount({ container, signal: controller.signal })
  }).then((result) => {
    pending = false
    clearTimeout(timer)
    if (result !== undefined && typeof result !== 'function') throw new Error('插件挂载返回值必须为清理函数')
    if (stopped) {
      if (result) runCleanup(result)
    } else {
      cleanup = result
    }
  }).catch((error) => {
    pending = false
    clearTimeout(timer)
    if (!stopped) {
      stop(); fail(error)
    }
  })
  return stop
}
