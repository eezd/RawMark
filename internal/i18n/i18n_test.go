package i18n

import (
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func TestNegotiate(t *testing.T) {
	for _, test := range []struct {
		header string
		want   Locale
	}{
		{"", English}, {"fr-FR", English}, {"en-US", English}, {"zh-CN", Chinese},
		{"zh-Hans,en;q=0.8", Chinese}, {"zh-CN;q=0.5,en;q=0.9", English},
		{"zh-CN;q=0,en", English}, {"zh-CN;q=invalid,en", English},
		{"en;q=0.5,zh-CN;q=0.5", English},
	} {
		if got := Negotiate(test.header); got != test.want {
			t.Errorf("%q: %q, want %q", test.header, got, test.want)
		}
	}
}
func TestCatalogParity(t *testing.T) {
	arguments := regexp.MustCompile(`%[a-z]`)
	for key, locales := range messages {
		if locales[English] == "" || locales[Chinese] == "" {
			t.Fatalf("missing translation: %s", key)
		}
		if !reflect.DeepEqual(arguments.FindAllString(locales[English], -1), arguments.FindAllString(locales[Chinese], -1)) {
			t.Errorf("argument mismatch: %s", key)
		}
	}
}
func TestStructuredErrorsKeepIdentityAndLocalizeCauses(t *testing.T) {
	sentinel := New("invalid_locale")
	err := New("w_destination_is_not_a_f9de1c", sentinel)
	if !errors.Is(err, sentinel) {
		t.Fatal("wrapped cause lost")
	}
	var detail *Error
	if !errors.As(err, &detail) {
		t.Fatal("structured error type lost")
	}
	if got := RenderError(err, English); got != "Language must be en or zh-CN: destination is not a folder" {
		t.Fatal(got)
	}
	if got := RenderError(err, Chinese); !strings.Contains(got, "语言必须为 en 或 zh-CN") {
		t.Fatal(got)
	}
	original := errors.New("external diagnostic")
	if errors.Is(New("operation_failed", original), original) {
		t.Fatal("non-wrapping format changed error identity")
	}
	if got := RenderError(errors.Join(err, original), English); !strings.Contains(got, "external diagnostic") {
		t.Fatal(got)
	}
	if fmt.Sprint(err) != RenderError(err, Chinese) {
		t.Fatal("log language changed")
	}
}
