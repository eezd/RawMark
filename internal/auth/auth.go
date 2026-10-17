// Package auth 实现单用户登录（Argon2id 密码哈希、会话令牌、登录限速），以及分享密码与 API 令牌的校验。
package auth

import (
	"crypto/hmac"
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
	shareSecretKey = "share.secret"
	apiTokenPrefix = "rm_"
	SessionTTL     = 30 * 24 * time.Hour
	MinPasswordLen = 8

	// RFC 9106 推荐的第二组参数（内存受限环境）
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 4
	argonKeyLen  = 32

	// 同一来源在窗口内累计失败 maxFailures 次（登录与分享密码合计）即封禁 lockout
	maxFailures   = 30
	failureWindow = 15 * time.Minute
	lockout       = 15 * time.Minute
)

var (
	ErrAlreadySetUp   = errors.New("已完成初始化")
	ErrBadSetupCode   = errors.New("启动码错误")
	ErrWeakPassword   = fmt.Errorf("密码至少 %d 位", MinPasswordLen)
	ErrBadCredentials = errors.New("密码错误")
	ErrRateLimited    = errors.New("尝试次数过多，请稍后再试")
	ErrBadScope       = errors.New("权限范围只能是 read 或 write")
)

type Manager struct {
	store *store.Store
	// 首次初始化需要的一次性启动码，仅打印在服务日志中，防止部署后被他人抢先设置密码
	setupCode string

	mu       sync.Mutex
	failures map[string][]time.Time
	blocked  map[string]time.Time // 来源 -> 解封时间
	now      func() time.Time
}

func New(s *store.Store) (*Manager, error) {
	m := &Manager{store: s, failures: map[string][]time.Time{}, blocked: map[string]time.Time{}, now: time.Now}
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

// ChangePassword 校验当前密码后设置新密码，并注销 keepToken 以外的所有会话
func (m *Manager) ChangePassword(ip, keepToken, current, next string) error {
	if !m.allow(ip) {
		return ErrRateLimited
	}
	encoded, _, err := m.store.Setting(passwordKey)
	if err != nil {
		return err
	}
	ok, err := verifyPassword(encoded, current)
	if err != nil {
		return err
	}
	if !ok {
		m.recordFailure(ip)
		return ErrBadCredentials
	}
	if len([]rune(next)) < MinPasswordLen {
		return ErrWeakPassword
	}
	if err := m.store.SetSetting(passwordKey, hashPassword(next)); err != nil {
		return err
	}
	return m.store.DeleteOtherSessions(hashToken(keepToken))
}

// ---- 分享 ----

// HashSharePassword 为分享密码生成哈希；空密码表示不设密码，返回空字符串
func HashSharePassword(password string) string {
	if password == "" {
		return ""
	}
	return hashPassword(password)
}

// CheckSharePassword 校验分享密码，与登录共用按来源的失败限速。
// 成功不清零失败计数：否则知道某个分享密码的人可以借此反复重置计数，无限尝试登录密码
func (m *Manager) CheckSharePassword(ip, hash, password string) error {
	if !m.allow(ip) {
		return ErrRateLimited
	}
	ok, err := verifyPassword(hash, password)
	if err != nil {
		return err
	}
	if !ok {
		m.recordFailure(ip)
		return ErrBadCredentials
	}
	return nil
}

// ShareCookie 生成输入分享密码后发给访客的凭据：绑定分享令牌与密码哈希，撤销分享即失效
func (m *Manager) ShareCookie(token, passwordHash string) (string, error) {
	secret, err := m.shareSecret()
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(token + "\x00" + passwordHash))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (m *Manager) ValidShareCookie(cookie, token, passwordHash string) (bool, error) {
	want, err := m.ShareCookie(token, passwordHash)
	if err != nil {
		return false, err
	}
	return hmac.Equal([]byte(cookie), []byte(want)), nil
}

// shareSecret 读取签名密钥，首次使用时生成并保存
func (m *Manager) shareSecret() ([]byte, error) {
	v, ok, err := m.store.Setting(shareSecretKey)
	if err != nil {
		return nil, err
	}
	if !ok {
		if _, err := m.store.SetSettingIfAbsent(shareSecretKey, randomToken()); err != nil {
			return nil, err
		}
		// 并发首次生成时以先写入的为准
		if v, _, err = m.store.Setting(shareSecretKey); err != nil {
			return nil, err
		}
	}
	return base64.RawURLEncoding.DecodeString(v)
}

// ---- API 令牌 ----

// CreateAPIToken 创建令牌，返回只显示这一次的明文
func (m *Manager) CreateAPIToken(name, scope string) (string, store.APIToken, error) {
	if scope != "read" && scope != "write" {
		return "", store.APIToken{}, ErrBadScope
	}
	plain := apiTokenPrefix + randomToken()
	t := store.APIToken{ID: randomCode(), Name: name, Hash: hashToken(plain), Scope: scope, CreatedAt: time.Now().UnixMilli()}
	if err := m.store.CreateAPIToken(t); err != nil {
		return "", store.APIToken{}, err
	}
	return plain, t, nil
}

// ValidateAPIToken 返回令牌的权限范围；无效时 ok 为 false
func (m *Manager) ValidateAPIToken(plain string) (scope string, ok bool, err error) {
	if !strings.HasPrefix(plain, apiTokenPrefix) {
		return "", false, nil
	}
	return m.store.UseAPIToken(hashToken(plain), time.Now().UnixMilli())
}

// ---- 限速：同一来源在时间窗口内失败过多则封禁一段时间 ----

func (m *Manager) allow(ip string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	until, ok := m.blocked[ip]
	if ok && m.now().Before(until) {
		return false
	}
	delete(m.blocked, ip)
	return true
}

func (m *Manager) recordFailure(ip string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	cutoff := now.Add(-failureWindow)
	recent := m.failures[ip][:0]
	for _, t := range m.failures[ip] {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	recent = append(recent, now)
	if len(recent) >= maxFailures {
		m.blocked[ip] = now.Add(lockout)
		delete(m.failures, ip)
		return
	}
	m.failures[ip] = recent
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

// NewShareToken 生成分享链接中的令牌（128 位随机数，比会话令牌短，便于复制）
func NewShareToken() string {
	b := make([]byte, 16)
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
