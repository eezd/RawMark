// Package auth 实现单用户登录：Argon2id 密码哈希、会话令牌与登录限速。
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"

	"rawmark/internal/store"
)

const (
	passwordKey    = "auth.password"
	SessionTTL     = 30 * 24 * time.Hour
	MinPasswordLen = 8

	// RFC 9106 推荐的第二组参数（内存受限环境）
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 4
	argonKeyLen  = 32

	maxFailures   = 5
	failureWindow = 15 * time.Minute
)

var (
	ErrAlreadySetUp   = errors.New("已完成初始化")
	ErrBadSetupCode   = errors.New("启动码错误")
	ErrWeakPassword   = fmt.Errorf("密码至少 %d 位", MinPasswordLen)
	ErrBadCredentials = errors.New("密码错误")
	ErrRateLimited    = errors.New("尝试次数过多，请稍后再试")
)

type Manager struct {
	store *store.Store
	// 首次初始化需要的一次性启动码，仅打印在服务日志中，防止部署后被他人抢先设置密码
	setupCode string

	mu       sync.Mutex
	failures map[string][]time.Time
}

func New(s *store.Store) (*Manager, error) {
	m := &Manager{store: s, failures: map[string][]time.Time{}}
	ok, err := m.IsSetUp()
	if err != nil {
		return nil, err
	}
	if !ok {
		m.setupCode = randomCode()
	}
	return m, nil
}

// SetupCode 返回启动码；已初始化时为空
func (m *Manager) SetupCode() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.setupCode
}

func (m *Manager) IsSetUp() (bool, error) {
	_, ok, err := m.store.Setting(passwordKey)
	return ok, err
}

func (m *Manager) Setup(code, password string) error {
	expected := m.SetupCode()
	if expected == "" {
		return ErrAlreadySetUp
	}
	if subtle.ConstantTimeCompare([]byte(strings.ToUpper(strings.TrimSpace(code))), []byte(expected)) != 1 {
		return ErrBadSetupCode
	}
	if len([]rune(password)) < MinPasswordLen {
		return ErrWeakPassword
	}
	ok, err := m.store.SetSettingIfAbsent(passwordKey, hashPassword(password))
	if err != nil {
		return err
	}
	if !ok {
		return ErrAlreadySetUp
	}
	m.mu.Lock()
	m.setupCode = ""
	m.mu.Unlock()
	return nil
}

// Login 校验密码并创建会话，返回明文令牌（仅存哈希）
func (m *Manager) Login(ip, password string) (string, error) {
	if !m.allow(ip) {
		return "", ErrRateLimited
	}
	encoded, ok, err := m.store.Setting(passwordKey)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", ErrBadCredentials
	}
	valid, err := verifyPassword(encoded, password)
	if err != nil {
		return "", err
	}
	if !valid {
		m.recordFailure(ip)
		return "", ErrBadCredentials
	}
	m.clearFailures(ip)
	token := randomToken()
	if err := m.store.CreateSession(hashToken(token), time.Now().Add(SessionTTL)); err != nil {
		return "", err
	}
	return token, nil
}

func (m *Manager) Validate(token string) (bool, error) {
	if token == "" {
		return false, nil
	}
	return m.store.SessionValid(hashToken(token), time.Now().Add(SessionTTL))
}

func (m *Manager) Logout(token string) error { return m.store.DeleteSession(hashToken(token)) }

// ---- 限速：同一来源在时间窗口内失败过多则拒绝 ----

func (m *Manager) allow(ip string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	cutoff := time.Now().Add(-failureWindow)
	recent := m.failures[ip][:0]
	for _, t := range m.failures[ip] {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	m.failures[ip] = recent
	return len(recent) < maxFailures
}

func (m *Manager) recordFailure(ip string) {
	m.mu.Lock()
	m.failures[ip] = append(m.failures[ip], time.Now())
	m.mu.Unlock()
}

func (m *Manager) clearFailures(ip string) {
	m.mu.Lock()
	delete(m.failures, ip)
	m.mu.Unlock()
}

// ---- 密码与令牌 ----

func hashPassword(password string) string {
	salt := make([]byte, 16)
	rand.Read(salt)
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, argonMemory, argonTime, argonThreads,
		b64.EncodeToString(salt), b64.EncodeToString(key))
}

func verifyPassword(encoded, password string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("密码哈希格式无法识别")
	}
	var mem uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &t, &p); err != nil {
		return false, fmt.Errorf("密码哈希参数无法解析: %w", err)
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(password), salt, t, mem, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

func randomToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// randomCode 生成形如 ABCD-EFGH 的启动码，去掉易混淆字符
func randomCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 8)
	rand.Read(b)
	out := make([]byte, 0, 9)
	for i, c := range b {
		if i == 4 {
			out = append(out, '-')
		}
		out = append(out, alphabet[int(c)%len(alphabet)])
	}
	return string(out)
}
