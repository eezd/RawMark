package vault

import (
	"errors"
	"testing"
)

func TestRejectWindowsDeviceAndAliasPaths(t *testing.T) {
	v := newVault(t)
	for _, name := range []string{"C:escape.md", "note.md:stream", "CON", "dir/NUL.md", "dir./note.md", "dir /note.md"} {
		if _, err := v.Write(name, []byte("must not write"), Precondition{}); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("unsafe Windows path %q: %v", name, err)
		}
	}
}
