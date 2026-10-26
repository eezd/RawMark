import * as authApi from '@@/apis/auth'
import { connectEventsApi } from '@@/apis/events'

// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { apiSuccess } from '../../../../tests/api-response'

afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
})

it('首次连接和重连均补同步，停止后不再连接', async () => {
  vi.spyOn(authApi, 'createResourceTicketApi').mockResolvedValue(apiSuccess({ url: '/api/v1/resources/once/events/', expiresAt: '2030-01-01T00:00:00Z' }))
  vi.useFakeTimers()
  class Socket {
    static CLOSED = 3
    static instances: Socket[] = []
    readyState = 0
    onopen?: () => void
    onclose?: () => void
    close() {
      this.readyState = Socket.CLOSED
    }

    constructor() {
      Socket.instances.push(this)
    }
  }
  vi.stubGlobal('WebSocket', Socket)
  let synchronized = 0
  const stop = connectEventsApi({ onEvents: () => {}, onResync: () => {
    synchronized++
  } })
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1))
  Socket.instances[0].onopen!()
  expect(synchronized).toBe(1)
  Socket.instances[0].onclose!()
  await vi.advanceTimersByTimeAsync(1000)
  Socket.instances[1].onopen!()
  expect(synchronized).toBe(2)
  stop()
  Socket.instances[1].onclose!()
  vi.advanceTimersByTime(30000)
  expect(Socket.instances).toHaveLength(2)
  expect(authApi.createResourceTicketApi).toHaveBeenCalledTimes(2)
})
