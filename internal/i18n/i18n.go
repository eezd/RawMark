// Package i18n keeps public messages structured until the HTTP boundary.
package i18n

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

type Locale string

const English Locale = "en"
const Chinese Locale = "zh-CN"

//go:embed messages.json
var source []byte
var messages = func() map[string]map[Locale]string {
	var values map[string]map[Locale]string
	if err := json.Unmarshal(source, &values); err != nil {
		panic(err)
	}
	return values
}()

// Negotiate supports the two shipped languages, honors quality weights, and
// defaults to English when the client omits or does not support a language.
func Negotiate(header string) Locale {
	selected, best := English, float64(-1)
	for _, item := range strings.Split(header, ",") {
		parts := strings.Split(strings.TrimSpace(item), ";")
		tag := strings.ToLower(strings.TrimSpace(parts[0]))
		quality := float64(1)
		for _, parameter := range parts[1:] {
			if value, ok := strings.CutPrefix(strings.TrimSpace(parameter), "q="); ok {
				parsed, err := strconv.ParseFloat(value, 64)
				if err != nil || parsed < 0 || parsed > 1 {
					quality = 0
				} else {
					quality = parsed
				}
			}
		}
		var candidate Locale
		switch {
		case tag == "en" || strings.HasPrefix(tag, "en-") || tag == "*":
			candidate = English
		case tag == "zh" || tag == "zh-cn" || tag == "zh-hans" || tag == "zh-hans-cn":
			candidate = Chinese
		default:
			continue
		}
		if quality > 0 && quality > best {
			selected, best = candidate, quality
		}
	}
	return selected
}

func Text(locale Locale, key string, args ...any) string {
	translations, ok := messages[key]
	if !ok {
		panic("unknown message key: " + key)
	}
	format, ok := translations[locale]
	if !ok {
		panic("unsupported message locale: " + string(locale))
	}
	if len(args) == 0 {
		return format
	}
	values := make([]any, len(args))
	for i, arg := range args {
		if err, ok := arg.(error); ok {
			values[i] = RenderError(err, locale)
		} else {
			values[i] = arg
		}
	}
	return fmt.Sprintf(strings.ReplaceAll(format, "%w", "%v"), values...)
}

type Error struct {
	Key    string
	Args   []any
	causes []error
}

func New(key string, args ...any) *Error {
	e := &Error{Key: key, Args: args}
	// Preserve fmt.Errorf wrapping semantics: %v shows a cause but does not wrap it.
	if len(args) > 0 {
		formatted := fmt.Errorf(messages[key][Chinese], args...)
		switch wrapped := formatted.(type) {
		case interface{ Unwrap() []error }:
			e.causes = wrapped.Unwrap()
		case interface{ Unwrap() error }:
			e.causes = []error{wrapped.Unwrap()}
		}
	}
	return e
}

// Error preserves the established Chinese diagnostics used in logs and indexes.
func (e *Error) Error() string   { return Text(Chinese, e.Key, e.Args...) }
func (e *Error) Unwrap() []error { return e.causes }

func RenderError(err error, locale Locale) string {
	if localized, ok := err.(*Error); ok {
		return Text(locale, localized.Key, localized.Args...)
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		parts := []string{}
		for _, cause := range joined.Unwrap() {
			parts = append(parts, RenderError(cause, locale))
		}
		return strings.Join(parts, "\n")
	}
	return err.Error()
}
