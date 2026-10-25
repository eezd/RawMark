// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { watchFontLoading } from './font-loading'

class Fonts extends EventTarget {
  status = 'loading'
  faces: { status: string }[] = []
  resolve!: () => void
  ready = this.pending()
  pending() {
    return new Promise<void>((resolve) => {
      this.resolve = resolve
    })
  }

  [Symbol.iterator]() {
    return this.faces[Symbol.iterator]()
  }

  finish() {
    this.status = 'loaded'; this.resolve()
  }

  load() {
    this.status = 'loading'; this.ready = this.pending(); this.dispatchEvent(new Event('loading'))
  }
}
let fonts: Fonts
let frame: FrameRequestCallback
const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts')
beforeEach(() => {
  document.body.innerHTML = '<div id="app">正文</div>'
  fonts = new Fonts()
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback; return 1
  })
  watchFontLoading()
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.rmFonts
  document.body.innerHTML = ''
  if (descriptor) Object.defineProperty(document, 'fonts', descriptor)
  else Reflect.deleteProperty(document, 'fonts')
})

it('挂载后的字体就绪前保持隐藏，等待结束才显示', async () => {
  expect(document.documentElement.dataset.rmFonts).toBe('loading')
  frame(0)
  await Promise.resolve()
  expect(document.documentElement.dataset.rmFonts).toBe('loading')
  fonts.finish()
  await Promise.resolve()
  expect(document.documentElement.dataset.rmFonts).toBe('ready')
})

it('字体已在缓存中时直接显示，不依赖再次触发 loading 事件', async () => {
  fonts.finish()
  frame(0)
  await Promise.resolve()
  expect(document.documentElement.dataset.rmFonts).toBe('ready')
})

it('切换笔记或字形需要新字体时重新等待，不用旧一轮完成信号提前显示', async () => {
  frame(0)
  fonts.finish()
  fonts.load()
  await Promise.resolve()
  expect(document.documentElement.dataset.rmFonts).toBe('loading')
  fonts.finish()
  await Promise.resolve()
  expect(document.documentElement.dataset.rmFonts).toBe('ready')
})

it('字体失败显示可刷新提示，之后 ready 完成和其他字体加载不能显示备用字体', async () => {
  frame(0)
  fonts.dispatchEvent(new Event('loadingerror'))
  fonts.dispatchEvent(new Event('loadingerror'))
  fonts.finish()
  await Promise.resolve()
  expect(document.documentElement.dataset.rmFonts).toBe('error')
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('字体加载失败')
  expect(document.querySelector('[role="alert"] button')!.textContent).toBe('刷新页面')
  fonts.load()
  expect(document.documentElement.dataset.rmFonts).toBe('error')
})

it('开始监听前已有字体失败，也不能被 resolved ready 当作成功', async () => {
  fonts.faces = [{ status: 'error' }]
  fonts.finish()
  frame(0)
  await Promise.resolve()
  expect(document.documentElement.dataset.rmFonts).toBe('error')
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
})
