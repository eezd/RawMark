package backup

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"rawmark/internal/i18n"
	"sync"
)

// LogWriter retains three application log files of at most 10 MiB each, with mode 0600.
type LogWriter struct {
	mu   sync.Mutex
	dir  string
	file *os.File
	size int64
}

func OpenLog(dir string) (*LogWriter, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "rawmark.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	return &LogWriter{dir: dir, file: f, size: info.Size()}, nil
}
func (l *LogWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(p) > 10<<20 {
		return 0, i18n.New("a_single_log_entry_exceeds_b1cdf6")
	}
	if l.size+int64(len(p)) > 10<<20 {
		if err := l.file.Close(); err != nil {
			return 0, err
		}
		for i := 2; i >= 1; i-- {
			dest := filepath.Join(l.dir, "rawmark.log.2")
			src := filepath.Join(l.dir, "rawmark.log.1")
			if i == 1 {
				dest = src
				src = filepath.Join(l.dir, "rawmark.log")
			}
			if err := os.Rename(src, dest); err != nil && !errors.Is(err, os.ErrNotExist) {
				return 0, err
			}
		}
		f, err := os.OpenFile(filepath.Join(l.dir, "rawmark.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return 0, err
		}
		l.file = f
		l.size = 0
	}
	n, err := l.file.Write(p)
	l.size += int64(n)
	return n, err
}
func (l *LogWriter) Close() error { l.mu.Lock(); defer l.mu.Unlock(); return l.file.Close() }

// Snapshot reads stable copies of current logs to avoid races with rotation during export.
func (l *LogWriter) Snapshot(dest string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.file.Sync(); err != nil {
		return err
	}
	for _, name := range []string{"rawmark.log", "rawmark.log.1", "rawmark.log.2"} {
		src, err := os.Open(filepath.Join(l.dir, name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		out, err := os.OpenFile(filepath.Join(dest, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			src.Close()
			return err
		}
		_, err = io.Copy(out, src)
		err = errors.Join(err, src.Close(), out.Close())
		if err != nil {
			return err
		}
	}
	return nil
}
