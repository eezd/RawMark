// Package auth implements single-user login (Argon2id hashes, session tokens, rate limiting) and API-token validation.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"rawmark/internal/i18n"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"

	"rawmark/internal/store"
)

const (
	passwordKey    = "auth.password"
	apiTokenPrefix = "rm_"
	SessionPrefix  = "rms_"
	SessionTTL     = 30 * 24 * time.Hour
	MinPasswordLen = 8

	// The second recommended parameter set in RFC 9106 (memory-constrained environments).
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 4
	argonKeyLen  = 32

	// Block a source for lockout after maxFailures failures within the window.
	maxFailures   = 30
	failureWindow = 15 * time.Minute
	lockout       = 15 * time.Minute
)

var (
	ErrAlreadySetUp   = i18n.New("setup_is_already_complete_222ec6")
	ErrWeakPassword   = i18n.New("password_must_contain_at_least_decf04", MinPasswordLen)
	ErrBadCredentials = i18n.New("incorrect_password_4585c8")
	ErrRateLimited    = i18n.New("too_many_attempts_please_try_8bbf6d")
	ErrBadScope       = i18n.New("scope_must_be_read_or_2cb466")
)

type Manager struct {
	store    *store.Store
	mu       sync.Mutex
	failures map[string][]time.Time
	blocked  map[string]time.Time // Source -> unblock time.
	now      func() time.Time
}

func New(s *store.Store) *Manager {
	return &Manager{store: s, failures: map[string][]time.Time{}, blocked: map[string]time.Time{}, now: time.Now}
}

func (m *Manager) IsSetUp() (bool, error) {
	_, ok, err := m.store.Setting(passwordKey)
	return ok, err
}

func (m *Manager) Setup(password string) error {
	// Reject initialized instances early to avoid repeated public password hashing; the database still makes concurrent first writes atomic.
	setUp, err := m.IsSetUp()
	if err != nil {
		return err
	}
	if setUp {
		return ErrAlreadySetUp
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
	return nil
}

// Login validates the password and creates a session, returning the plaintext token (only its hash is stored).
func (m *Manager) Login(ip, password string) (string, error) {
	return m.AttemptLogin(ip, password, nil)
}

// AttemptLogin validates the login challenge and password within one rate-limit boundary; setup needs no challenge.
func (m *Manager) AttemptLogin(ip, password string, challenge func() error) (string, error) {
	if !m.allow(ip) {
		return "", ErrRateLimited
	}
	if challenge != nil {
		if err := challenge(); err != nil {
			m.recordFailure(ip)
			return "", err
		}
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
	token := SessionPrefix + randomToken()
	if err := m.store.CreateSession(hashToken(token), m.now().Add(SessionTTL)); err != nil {
		return "", err
	}
	return token, nil
}

func (m *Manager) Validate(token string) (bool, error) {
	_, ok, err := m.SessionExpiry(token)
	return ok, err
}

func (m *Manager) SessionExpiry(token string) (time.Time, bool, error) {
	if !strings.HasPrefix(token, SessionPrefix) {
		return time.Time{}, false, nil
	}
	return m.store.SessionExpiry(hashToken(token), m.now())
}

func (m *Manager) Logout(token string) error { return m.store.DeleteSession(hashToken(token)) }

// ChangePassword verifies the current password, sets the new one, and revokes all sessions except keepToken.
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

// ---- API tokens ----

// CreateAPIToken creates a token and returns its plaintext value for one-time display.
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

// ValidateAPIToken returns a token's scope; ok is false for an invalid token.
func (m *Manager) ValidateAPIToken(plain string) (scope string, ok bool, err error) {
	if !strings.HasPrefix(plain, apiTokenPrefix) {
		return "", false, nil
	}
	return m.store.UseAPIToken(hashToken(plain), time.Now().UnixMilli())
}

// ---- Rate limiting: temporarily block sources with too many failures within the window ----

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

// ---- Passwords and tokens ----

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
		return false, i18n.New("unrecognized_password_hash_format_2f5457")
	}
	var mem uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &t, &p); err != nil {
		return false, i18n.New("could_not_parse_password_hash_3cd93b", err)
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

// randomCode generates an API-token identifier such as ABCD-EFGH, excluding ambiguous characters.
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
