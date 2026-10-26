package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// events pushes vault changes over WebSocket. websocket.Accept checks that Origin matches Host by default.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	s.eventWG.Add(1)
	defer s.eventWG.Done()
	// Subscribe before completing the handshake so the first change cannot fall into a subscription gap.
	msgs, unsubscribe := s.hub.Subscribe()
	defer unsubscribe()
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	reauthorize := func() bool {
		principal := identity(r)
		valid, err := s.validPrincipal(principal)

		if err != nil {
			slog.Error("事件连接鉴权失败", "err", err)
			conn.Close(websocket.StatusInternalError, "鉴权失败")
			return false
		}
		if !valid {
			conn.Close(websocket.StatusPolicyViolation, "登录凭据已失效")
			return false
		}
		return true
	}
	// Clients send no messages; CloseRead handles control frames and cancels ctx on disconnect.
	ctx := conn.CloseRead(r.Context())
	// Ping periodically to prevent idle disconnects by reverse proxies.
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-msgs:
			if !ok {
				// Disconnect slow subscribers removed from the hub; clients reconnect and perform a full sync.
				conn.Close(websocket.StatusTryAgainLater, "too slow")
				return
			}
			if !reauthorize() {
				return
			}
			if err := writeWithTimeout(ctx, conn, msg); err != nil {
				return
			}
		case <-ping.C:
			if !reauthorize() {
				return
			}
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
