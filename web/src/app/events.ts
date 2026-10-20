// 订阅服务端的仓库变更事件；断线后指数退避重连，每次连接成功时触发全量同步

export interface VaultEvent {
  type: 'tree' | 'changed' | 'deleted' | 'moved' | 'settings' | 'plugins'
  path?: string
  from?: string
  rev?: string
}

export function connectEvents(handlers: { onEvents: (evs: VaultEvent[]) => void; onResync: () => void }): () => void {
  let ws: WebSocket | undefined
  let delay = 1000
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${proto}//${location.host}/api/v1/events`)
    ws.onopen = () => {
      delay = 1000
      // 初始化读取到首次订阅之间也存在空窗，每次建立连接都补同步。
      handlers.onResync()
    }
    ws.onmessage = (e) => handlers.onEvents(JSON.parse(e.data))
    ws.onclose = () => {
      if (stopped) return
      timer = setTimeout(connect, delay)
      delay = Math.min(delay * 2, 30000)
    }
  }
  connect()
  // 页面从后台恢复时立即重连，不等退避计时
  const onVisible = () => {
    if (document.visibilityState === 'visible' && ws?.readyState === WebSocket.CLOSED) {
      clearTimeout(timer)
      connect()
    }
  }
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
    ws?.close()
  }
}
