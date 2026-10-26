// Package events broadcasts vault changes to all connected clients over WebSocket.
package events

import (
	"encoding/json"
	"log/slog"
	"sync"
)

// Event is a message pushed to clients.
//
//	tree     Directory structure changed (create/delete/move); clients reload the tree.
//	changed  Note contents changed; Rev contains the new revision.
//	deleted  A note was deleted.
//	moved    A file or folder moved (From -> Path); folder events include child path mappings.
//	settings Application settings changed; clients reload them.
type Event struct {
	Type string `json:"type"`
	Path string `json:"path,omitempty"`
	From string `json:"from,omitempty"`
	Rev  string `json:"rev,omitempty"`
}

type Hub struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
	closed  bool
}

func NewHub() *Hub { return &Hub{clients: map[chan []byte]struct{}{}} }

// Subscribe returns a message channel and cancel function. Slow clients are disconnected and must reconnect and fully sync.
func (h *Hub) Subscribe() (<-chan []byte, func()) {
	ch := make(chan []byte, 64)
	h.mu.Lock()
	if h.closed {
		close(ch)
		h.mu.Unlock()
		return ch, func() {}
	}
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

// Close rejects new subscriptions and closes existing connections so instance recovery can reopen databases.
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for ch := range h.clients {
		delete(h.clients, ch)
		close(ch)
	}
}
