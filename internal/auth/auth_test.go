package auth

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"rawmark/internal/store"
)

func newManager(t *testing.T) (*Manager, *time.Time) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "rawmark.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	m := New(st)
	if err := m.Setup("password123"); err != nil {
		t.Fatal(err)
	}
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	m.now = func() time.Time { return clock }
	return m, &clock
}

// 登录与分享密码合计 30 次失败后封禁 15 分钟，期间正确密码也被拒绝
func TestRateLimit(t *testing.T) {
	m, clock := newManager(t)
	share := HashSharePassword("share-pass")
	for i := 0; i < maxFailures-1; i++ {
		var err error
		if i%2 == 0 {
			_, err = m.Login("1.1.1.1", "wrong")
		} else {
			err = m.CheckSharePassword("1.1.1.1", share, "wrong")
		}
		if !errors.Is(err, ErrBadCredentials) {
			t.Fatalf("第 %d 次失败: %v", i+1, err)
		}
	}
	// 分享密码正确不清零计数
	if err := m.CheckSharePassword("1.1.1.1", share, "share-pass"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Login("1.1.1.1", "wrong"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("第 30 次失败: %v", err)
	}
	if _, err := m.Login("1.1.1.1", "password123"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("封禁期间正确密码也应被拒绝: %v", err)
	}
	if err := m.CheckSharePassword("1.1.1.1", share, "share-pass"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("封禁同样作用于分享密码: %v", err)
	}
	if _, err := m.Login("2.2.2.2", "password123"); err != nil {
		t.Fatalf("其他来源不受影响: %v", err)
	}
	*clock = clock.Add(lockout - time.Second)
	if _, err := m.Login("1.1.1.1", "password123"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("未满 15 分钟仍封禁: %v", err)
	}
	*clock = clock.Add(time.Second)
	if _, err := m.Login("1.1.1.1", "password123"); err != nil {
		t.Fatalf("15 分钟后解封: %v", err)
	}
}

// 窗口外的失败不计入；登录成功清零
func TestRateLimitWindow(t *testing.T) {
	m, clock := newManager(t)
	for i := 0; i < maxFailures-1; i++ {
		m.Login("1.1.1.1", "wrong")
	}
	*clock = clock.Add(failureWindow + time.Second)
	for i := 0; i < maxFailures-1; i++ {
		m.Login("1.1.1.1", "wrong")
	}
	if _, err := m.Login("1.1.1.1", "password123"); err != nil {
		t.Fatalf("15 分钟前的失败不应计入: %v", err)
	}
	for i := 0; i < maxFailures-1; i++ {
		m.Login("1.1.1.1", "wrong")
	}
	if _, err := m.Login("1.1.1.1", "wrong"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("登录成功后计数应已清零: %v", err)
	}
	if _, err := m.Login("1.1.1.1", "password123"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("清零后再失败 30 次应封禁: %v", err)
	}
}
