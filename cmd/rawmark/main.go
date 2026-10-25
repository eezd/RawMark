// RawMark 服务入口。配置全部来自环境变量：
//
//	RAWMARK_DATA   数据目录，默认 /data（存放 rawmark.db、可重建的搜索索引 index.db 与默认仓库）
//	RAWMARK_VAULT  笔记仓库目录，默认 $RAWMARK_DATA/vault；可指向已有的 Typora 笔记目录
//	RAWMARK_ADDR   监听地址，默认 :8080
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"rawmark/internal/api"
	"rawmark/internal/auth"
	"rawmark/internal/backup"
	"rawmark/internal/events"
	"rawmark/internal/search"
	"rawmark/internal/store"
	"rawmark/internal/vault"
	"rawmark/internal/watch"
	"rawmark/web"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	addr := env("RAWMARK_ADDR", ":8080")
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck(addr))
	}
	if err := run(addr); err != nil {
		slog.Error("服务退出", "err", err)
		os.Exit(1)
	}
}

func run(addr string) error {
	dataDir := env("RAWMARK_DATA", "/data")
	vaultDir := env("RAWMARK_VAULT", filepath.Join(dataDir, "vault"))
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return permissionHint(err)
	}

	dataDir, err := filepath.Abs(dataDir)
	if err != nil {
		return err
	}
	vaultDir, err = filepath.Abs(vaultDir)
	if err != nil {
		return err
	}
	// 所有标准库上传、导出临时文件归本进程专属目录，不能清理宿主机 /tmp。
	tempDir := filepath.Join(dataDir, "temp")
	if err = os.MkdirAll(tempDir, 0700); err != nil {
		return err
	}
	if err = os.Setenv("TMPDIR", tempDir); err != nil {
		return err
	}
	logs, err := backup.OpenLog(filepath.Join(dataDir, "logs"))
	if err != nil {
		return err
	}
	defer logs.Close()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.MultiWriter(os.Stderr, logs), nil)))
	fontsSize, err := web.FontStorage()
	if err != nil {
		return fmt.Errorf("读取内置字体统计失败: %w", err)
	}
	buildVersion, err := web.BuildVersion()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	for {
		var restoreErr error
		if restoreErr = backup.Recover(dataDir, vaultDir); restoreErr != nil {
			pending, err := backup.Pending(dataDir)
			if err != nil {
				return err
			}
			if pending {
				return restoreErr
			}
			slog.Error("实例恢复失败，已回退", "err", restoreErr)
		}
		restart, err := serve(ctx, addr, dataDir, vaultDir, buildVersion, fontsSize, logs, restoreErr)
		if err != nil {
			pending, pendingErr := backup.Pending(dataDir)
			if pendingErr != nil {
				return errors.Join(err, pendingErr)
			}
			if pending {
				slog.Error("新实例初始化失败，回退原实例", "err", err)
				continue
			}
			return err
		}
		if !restart {
			return nil
		}
	}
}

func serve(parent context.Context, addr, dataDir, vaultDir, version string, fontSize int64, logs *backup.LogWriter, restoreErr error) (bool, error) {
	v, err := vault.Open(vaultDir)
	if err != nil {
		return false, permissionHint(err)
	}
	st, err := store.Open(filepath.Join(dataDir, "rawmark.db"))
	if err != nil {
		return false, err
	}
	defer st.Close()
	idx, err := search.Open(filepath.Join(dataDir, "index.db"), v)
	if err != nil {
		return false, err
	}
	defer idx.Close()
	ctx, cancel := context.WithCancel(parent)
	pending, err := backup.Pending(dataDir)
	if err != nil {
		cancel()
		return false, err
	}
	if pending {
		if err = idx.Rebuild(ctx); err != nil {
			cancel()
			return false, err
		}
	}
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	hub := events.NewHub()
	idx.OnIndexed = func() { hub.Broadcast(events.Event{Type: "indexed"}) }
	workers.Go(func() { idx.Run(ctx) })
	watchDone, err := watch.Start(ctx, v, hub, idx.Update)
	if err != nil {
		return false, err
	}
	defer func() { cancel(); <-watchDone }()
	srv := api.New(v, auth.New(st), st, hub, idx)
	srv.DataDir = dataDir
	srv.ThemesDir = filepath.Join(dataDir, "themes")
	srv.PluginsDir = filepath.Join(dataDir, "plugins")
	srv.FontsDir = filepath.Join(dataDir, "fonts")
	srv.BuiltinFontsSize = fontSize
	srv.Logs = logs
	srv.Version = version
	if restoreErr != nil {
		srv.SetRestoreFailure(restoreErr)
	}
	restart := make(chan struct{}, 1)
	srv.Restart = func() {
		select {
		case restart <- struct{}{}:
		default:
		}
	}
	workers.Go(func() { srv.RunTrashCleanup(ctx) })
	workers.Go(func() { cleanupSessions(ctx, st) })
	server := &http.Server{Addr: addr, Handler: srv.Handler(web.Dist()), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
	errorsCh := make(chan error, 1)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return false, err
	}
	if err = backup.FinishRecovery(dataDir); err != nil {
		listener.Close()
		return false, err
	}
	go func() { errorsCh <- server.Serve(listener) }()
	slog.Info("RawMark 已启动", "addr", addr, "vault", v.Root())
	requested := false
	select {
	case err = <-errorsCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return false, err
		}
	case <-ctx.Done():
	case <-restart:
		requested = true
	}
	shutdown, done := context.WithTimeout(context.Background(), 15*time.Second)
	defer done()
	if err = server.Shutdown(shutdown); err != nil {
		return false, err
	}
	srv.CloseEvents()
	cancel()
	return requested, nil
}

// permissionHint 为权限错误补充排查提示：Docker 绑定挂载的宿主机目录常常对容器内的非 root 用户不可写
func permissionHint(err error) error {
	if errors.Is(err, fs.ErrPermission) {
		return fmt.Errorf("%w（当前 UID %d 对数据目录没有写权限：请用 --user 指定宿主机目录所有者的 UID:GID，或执行 chown 修改目录所有者）", err, os.Getuid())
	}
	return err
}

func cleanupSessions(ctx context.Context, st *store.Store) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := st.DeleteExpiredSessions(); err != nil {
				slog.Warn("清理过期会话失败", "err", err)
			}
		}
	}
}

// healthcheck 供 Docker HEALTHCHECK 使用（distroless 镜像中没有 curl）
func healthcheck(addr string) int {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 1
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/api/v1/health")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
