package api

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/dchest/captcha"
	"rawmark/internal/auth"
)

var (
	errCaptchaInvalid = errors.New("验证码错误或已使用，请刷新后重试")
	errCaptchaExpired = errors.New("验证码已过期，请刷新后重试")
)

type loginChallenge struct {
	digits  []byte
	source  string
	expires time.Time
}
type captchaManager struct {
	mu         sync.Mutex
	challenges map[string]loginChallenge
	issued     map[string][]time.Time
	now        func() time.Time
}

func newCaptchas() *captchaManager {
	return &captchaManager{challenges: map[string]loginChallenge{}, issued: map[string][]time.Time{}, now: time.Now}
}

func opaqueToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (c *captchaManager) create(source, replace string) (string, loginChallenge, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for id, item := range c.challenges {
		if !now.Before(item.expires) {
			delete(c.challenges, id)
		}
	}
	for ip, times := range c.issued {
		recent := times[:0]
		for _, t := range times {
			if now.Sub(t) < time.Minute {
				recent = append(recent, t)
			}
		}
		if len(recent) == 0 {
			delete(c.issued, ip)
		} else {
			c.issued[ip] = recent
		}
	}
	if len(c.issued[source]) >= 60 || len(c.challenges) >= 10000 {
		return "", loginChallenge{}, auth.ErrRateLimited
	}
	if previous, ok := c.challenges[replace]; ok && previous.source == source {
		delete(c.challenges, replace)
	}
	id := opaqueToken()
	item := loginChallenge{digits: captcha.RandomDigits(6), source: source, expires: now.Add(5 * time.Minute)}
	c.challenges[id] = item
	c.issued[source] = append(c.issued[source], now)
	return id, item, nil
}

func (c *captchaManager) consume(source, id, code string) error {
	c.mu.Lock()
	item, ok := c.challenges[id]
	delete(c.challenges, id)
	now := c.now()
	c.mu.Unlock()
	if !ok || item.source != source {
		return errCaptchaInvalid
	}
	if !now.Before(item.expires) {
		return errCaptchaExpired
	}
	if len(code) != 6 {
		return errCaptchaInvalid
	}
	digits := []byte(code)
	for i, v := range digits {
		if v < '0' || v > '9' {
			return errCaptchaInvalid
		}
		digits[i] = v - '0'
	}
	if subtle.ConstantTimeCompare(digits, item.digits) != 1 {
		return errCaptchaInvalid
	}
	return nil
}

func (s *Server) createCaptcha(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ReplaceID string `json:"replaceId"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	id, item, err := s.captchas.create(clientIP(r), body.ReplaceID)
	if err != nil {
		writeError(w, 429, err.Error())
		return
	}
	var png bytes.Buffer
	if _, err = captcha.NewImage(id, item.digits, 240, 80).WriteTo(&png); err != nil {
		internalError(w, r, err)
		return
	}
	writeJSON(w, 200, map[string]any{"captchaId": id, "imageDataUrl": "data:image/png;base64," + base64.StdEncoding.EncodeToString(png.Bytes()), "expiresAt": item.expires})
}
