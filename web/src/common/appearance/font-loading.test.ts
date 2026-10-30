// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { watchFontLoading } from './font-loading'

function face(overrides = {}) {
  return { family: 'Maple Mono Normal NL NF CN', weight: '400', style: 'normal', status: 'unloaded', load: vi.fn().mockResolvedValue(undefined), ...overrides }
}
class Fonts extends EventTarget {
  faces = [face()];
  [Symbol.iterator]() {
    return this.faces[Symbol.iterator]()
  }
}
let fonts: Fonts
let frame: FrameRequestCallback
const descriptor = Object.getOwnPropertyDescriptor(document, 'fonts')
beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = '<div id="app">正文</div>'
  fonts = new Fonts()
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback; return 1
  })
})
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals()
  document.body.innerHTML = ''
  if (descriptor) Object.defineProperty(document, 'fonts', descriptor)
  else Reflect.deleteProperty(document, 'fonts')
})
it('首屏与后续字体加载均不隐藏或禁用应用，预下载不阻塞首屏', async () => {
  watchFontLoading()
  expect(fonts.faces[0]!.load).not.toHaveBeenCalled()
  fonts.dispatchEvent(new Event('loading'))
  expect(document.documentElement.dataset.rmFonts).toBeUndefined()
  expect(getComputedStyle(document.getElementById('app')!).pointerEvents).not.toBe('none')
  frame(0)
  expect(fonts.faces[0]!.load).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  expect(fonts.faces[0]!.load).toHaveBeenCalledOnce()
})
it('只预下载常规Maple，每批两个，单片失败仍继续且不重复启动', async () => {
  let finish!: () => void
  fonts.faces = [face({ family: '\'Maple Mono Normal NL NF CN\'', load: vi.fn(() => new Promise<void>((resolve) => {
    finish = resolve
  })) }), face({ load: vi.fn().mockRejectedValue(new Error('offline')) }), face(), face({ weight: '700' }), face({ style: 'italic' }), face({ family: 'Other font' })]
  watchFontLoading(); frame(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(fonts.faces[0]!.load).toHaveBeenCalledOnce()
  expect(fonts.faces[1]!.load).toHaveBeenCalledOnce()
  expect(fonts.faces[2]!.load).not.toHaveBeenCalled()
  finish(); await vi.advanceTimersByTimeAsync(0)
  expect(fonts.faces[2]!.load).toHaveBeenCalledOnce()
  for (const font of fonts.faces.slice(3)) expect(font.load).not.toHaveBeenCalled()
  watchFontLoading(); await vi.advanceTimersByTimeAsync(0)
  expect(fonts.faces[0]!.load).toHaveBeenCalledOnce()
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
})
it('字体失败只提示一次，保留页面和刷新重试入口', () => {
  watchFontLoading()
  fonts.dispatchEvent(new Event('loadingerror')); fonts.dispatchEvent(new Event('loadingerror'))
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('Using fallback fonts')
  expect(document.querySelector('[role="alert"] button')!.textContent).toBe('Refresh page')
  expect(document.documentElement.dataset.rmFonts).toBeUndefined()
})
