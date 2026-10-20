// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { connectEvents } from './events'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('首次连接和重连均补同步，停止后不再连接', () => {
  vi.useFakeTimers()
  class Socket {
    static CLOSED = 3
    static instances: Socket[] = []
    readyState = 0
    onopen?: () => void
    onclose?: () => void
    close() { this.readyState = Socket.CLOSED }
    constructor() { Socket.instances.push(this) }
  }
  vi.stubGlobal('WebSocket', Socket)
  let synchronized = 0
  const stop = connectEvents({ onEvents: () => {}, onResync: () => { synchronized++ } })
  Socket.instances[0].onopen!()
  expect(synchronized).toBe(1)
  Socket.instances[0].onclose!()
  vi.advanceTimersByTime(1000)
  Socket.instances[1].onopen!()
  expect(synchronized).toBe(2)
  stop()
  Socket.instances[1].onclose!()
  vi.advanceTimersByTime(30000)
  expect(Socket.instances).toHaveLength(2)
})
