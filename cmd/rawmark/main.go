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
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"rawmark/internal/api"
	"rawmark/internal/auth"
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
	v, err := vault.Open(vaultDir)
	if err != nil {
		return permissionHint(fmt.Errorf("打开笔记仓库失败: %w", err))
	}
	st, err := store.Open(filepath.Join(dataDir, "rawmark.db"))
	if err != nil {
		return err
	}
	defer st.Close()
	am := auth.New(st)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	idx, err := search.Open(filepath.Join(dataDir, "index.db"), v)
	if err != nil {
		return err
	}
	defer idx.Close()
	go idx.Run(ctx)

	hub := events.NewHub()
	if err := watch.Start(ctx, v, hub, idx.Update); err != nil {
		return fmt.Errorf("启动文件监听失败: %w", err)
	}
	go cleanupSessions(ctx, st)

	srv := api.New(v, am, st, hub, idx)
	srv.ThemesDir = filepath.Join(dataDir, "themes")
	srv.PluginsDir = filepath.Join(dataDir, "plugins")
	go srv.FollowMoves(ctx)
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(web.Dist()),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.ListenAndServe() }()
	slog.Info("RawMark 已启动", "addr", addr, "vault", v.Root())

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	slog.Info("正在关闭")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
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
