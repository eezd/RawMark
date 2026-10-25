package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestResourceTicketSurvivesReopenAndExpires(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rawmark.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Hour).Truncate(time.Second)
	if err = s.CreateSession("parent", expires); err != nil {
		t.Fatal(err)
	}
	if err = s.CreateTicket(ResourceTicket{Hash: "ticket-hash", SessionHash: "parent", Kind: "images", ExpiresAt: expires}); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ticket, ok, err := s.Ticket("ticket-hash", false, time.Now())
	if err != nil || !ok || ticket.Kind != "images" || ticket.SessionHash != "parent" || !ticket.ExpiresAt.Equal(expires) {
		t.Fatal("重启后资源票据契约变化", err)
	}
	if _, ok, err = s.Ticket("ticket-hash", false, expires); err != nil || ok {
		t.Fatal("过期票据仍有效", err)
	}
	if err = s.DeleteSession("parent"); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteExpiredSessions(); err != nil {
		t.Fatal(err)
	}
	if _, ok, err = s.Ticket("ticket-hash", false, time.Now()); err != nil || ok {
		t.Fatal("未清理孤立票据", err)
	}
}
