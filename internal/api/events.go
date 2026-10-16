package api

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// events 通过 WebSocket 推送仓库变更。websocket.Accept 默认校验 Origin 与 Host 一致
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	// 客户端不发消息；CloseRead 负责处理控制帧并在连接断开时取消 ctx
	ctx := conn.CloseRead(r.Context())
	msgs, unsubscribe := s.hub.Subscribe()
	defer unsubscribe()
	// 定期 ping，避免反向代理因空闲断开连接
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-msgs:
			if !ok {
				// 客户端消费过慢被移出广播列表，断开后由客户端重连并全量同步
				conn.Close(websocket.StatusTryAgainLater, "too slow")
				return
			}
			if err := writeWithTimeout(ctx, conn, msg); err != nil {
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Ping(pctx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func writeWithTimeout(ctx context.Context, conn *websocket.Conn, msg []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, msg)
}
