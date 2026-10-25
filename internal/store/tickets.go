package store

import (
	"database/sql"
	"errors"
	"time"
)

// ResourceTicket 只保存资源凭据哈希，所属登录会话是授权的最终依据。
type ResourceTicket struct {
	Hash        string
	SessionHash string
	Kind        string
	Resource    string
	Revision    string
	ExpiresAt   time.Time
}

func (s *Store) CreateTicket(t ResourceTicket) error {
	_, err := s.db.Exec(`INSERT INTO resource_tickets(token_hash,session_hash,kind,resource,revision,expires_at) VALUES(?,?,?,?,?,?)`, t.Hash, t.SessionHash, t.Kind, t.Resource, t.Revision, t.ExpiresAt.Unix())
	return err
}

func (s *Store) Ticket(hash string, consume bool, now time.Time) (ResourceTicket, bool, error) {
	var t ResourceTicket
	var expires int64
	query := `SELECT token_hash,session_hash,kind,resource,revision,expires_at FROM resource_tickets WHERE token_hash = ? AND expires_at > ?`
	// 事件握手票据原子消费；资源票据可在父会话有效期内读取。
	if consume {
		query = `DELETE FROM resource_tickets WHERE token_hash = ? AND expires_at > ? AND kind = 'events' RETURNING token_hash,session_hash,kind,resource,revision,expires_at`
	}
	err := s.db.QueryRow(query, hash, now.Unix()).Scan(&t.Hash, &t.SessionHash, &t.Kind, &t.Resource, &t.Revision, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return t, false, nil
	}
	t.ExpiresAt = time.Unix(expires, 0).UTC()
	return t, err == nil, err
}
