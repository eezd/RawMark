// 订阅服务端的仓库变更事件；断线后指数退避重连，重连成功时触发全量同步

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
  let connectedBefore = false

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${proto}//${location.host}/api/v1/events`)
    ws.onopen = () => {
      delay = 1000
      // 首次连接前的状态由初始化加载，之后每次重连都可能错过事件
      if (connectedBefore) handlers.onResync()
      connectedBefore = true
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
