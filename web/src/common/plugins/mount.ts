import type { AsyncCleanup, Awaitable, MountContext } from '@@/plugin-api'
import { t as translate } from '@@/i18n/runtime'

// Each mount gets its own container; asynchronous rendering after timeout or disable can only modify a detached container.
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
    fail(new Error(translate('common.plugin_view_rendering_exceeded_seconds_0d20d2')))
  }, 10_000)
  void Promise.resolve().then(() => {
    if (!stopped) return mount({ container, signal: controller.signal })
  }).then((result) => {
    pending = false
    clearTimeout(timer)
    if (result !== undefined && typeof result !== 'function') throw new Error(translate('common.plugin_mount_must_return_a_c66e82'))
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
