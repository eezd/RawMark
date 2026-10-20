// Package events 把仓库变更广播给所有在线客户端（WebSocket）。
package events

import (
	"encoding/json"
	"log/slog"
	"sync"
)

// Event 为推送给客户端的消息
//
//	tree     目录结构变化（新增/删除/移动），客户端重新拉取目录树
//	changed  笔记内容变化，Rev 为新版本
//	deleted  笔记被删除
//	moved    文件或目录被移动（From -> Path），目录事件包含其子项的路径映射
//	settings 应用设置变化，客户端重新读取
type Event struct {
	Type string `json:"type"`
	Path string `json:"path,omitempty"`
	From string `json:"from,omitempty"`
	Rev  string `json:"rev,omitempty"`
}

type Hub struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
}

func NewHub() *Hub { return &Hub{clients: map[chan []byte]struct{}{}} }

// Subscribe 返回消息通道与取消函数；通道在客户端跟不上时会被关闭，客户端应重连并全量同步
func (h *Hub) Subscribe() (<-chan []byte, func()) {
	ch := make(chan []byte, 64)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		if _, ok := h.clients[ch]; ok {
			delete(h.clients, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
}

func (h *Hub) Broadcast(events ...Event) {
	if len(events) == 0 {
		return
	}
	msg, err := json.Marshal(events)
	if err != nil {
		slog.Error("序列化事件失败", "err", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- msg:
		default:
			delete(h.clients, ch)
			close(ch)
		}
	}
}
