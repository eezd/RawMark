import type { EventHandlers } from './type'

import { createResourceTicketApi } from '@@/apis/auth'

// 订阅仓库事件；每次连接领取一次性票据，重连后补全量同步。
import { isCancel } from 'axios'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'

export function connectEventsApi(handlers: EventHandlers): () => void {
  const user = useUserStore(pinia)
  const version = user.getSessionVersion()
  let socket: WebSocket | undefined
  let delay = 1000
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let connecting = false

  function reconnect() {
    if (stopped || version !== user.getSessionVersion()) return
    timer = setTimeout(() => void connect(), delay)
    delay = Math.min(delay * 2, 30000)
  }
  async function connect() {
    if (stopped || connecting) return
    connecting = true
    try {
      const ticket = (await createResourceTicketApi({ kind: 'events' })).data
      user.assertSession(version)
      if (stopped) return
      const url = new URL(ticket.url, location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(url)
      socket = ws
      ws.onopen = () => {
        delay = 1000
        handlers.onResync()
      }
      ws.onmessage = event => handlers.onEvents(JSON.parse(event.data))
      ws.onclose = reconnect
    } catch (error) {
      if (!isCancel(error)) reconnect()
    } finally {
      connecting = false
    }
  }
  void connect()
  const onVisible = () => {
    if (document.visibilityState === 'visible' && (!socket || socket.readyState === WebSocket.CLOSED)) {
      clearTimeout(timer)
      void connect()
    }
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
    socket?.close()
  }
}
