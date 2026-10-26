#!/usr/bin/env bash
# Start Go (go run -tags dev) and Vite with hot updates; Ctrl+C stops both.
#
# Usage: scripts/dev.sh [--host]
#   --host  Listen on all interfaces for LAN access from phones/tablets.
#
# Environment variables:
#   RAWMARK_DATA  Development data directory; defaults to <repository>/.dev-data.
#   API_PORT      Backend port; defaults to 8080 (also used by the Vite proxy).
#   WEB_PORT      Frontend port; defaults to 5173.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export RAWMARK_DATA="${RAWMARK_DATA:-$ROOT/.dev-data}"
export API_PORT="${API_PORT:-8080}"
WEB_PORT="${WEB_PORT:-5173}"
VITE_ARGS=(--port "$WEB_PORT" --strictPort)

for arg in "$@"; do
  case "$arg" in
    --host) VITE_ARGS+=(--host) ;;
    -h | --help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（可用 --host、--help）" >&2
      exit 1
      ;;
  esac
done

# The default Go installation may be missing from PATH in non-login shells.
[[ -d /usr/local/go/bin ]] && export PATH="$PATH:/usr/local/go/bin"

fail() {
  echo "错误：$*" >&2
  exit 1
}

command -v go >/dev/null || fail "未找到 go，请安装 Go 1.27 或更高版本"
command -v node >/dev/null || fail "未找到 node，请安装 Node.js 24 或更高版本"
command -v pnpm >/dev/null || fail "未找到 pnpm，请启用 pnpm 12.11.2"

port_in_use() {
  if command -v ss >/dev/null; then
    ss -ltn "sport = :$1" | grep -q LISTEN
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}
port_in_use "$API_PORT" && fail "端口 $API_PORT 已被占用（后端）"
port_in_use "$WEB_PORT" && fail "端口 $WEB_PORT 已被占用（前端）"

# Let pnpm verify locked dependencies and reuse cached packages when available.
echo "==> 核对前端依赖"
pnpm -C web install --frozen-lockfile

# On exit, stop every child started here, including the service compiled by go run.
cleanup() {
  trap - EXIT INT TERM
  echo
  echo "==> 正在停止"
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Prefix both log streams to distinguish them.
prefix() { sed -u "s/^/[$1] /"; }

echo "==> 启动后端 http://127.0.0.1:$API_PORT（数据目录 $RAWMARK_DATA）"
RAWMARK_ADDR="127.0.0.1:$API_PORT" go run -tags dev ./cmd/rawmark 2>&1 | prefix server &

# Wait for the backend before starting Vite to avoid failed requests during initial compilation.
for _ in $(seq 1 120); do
  curl -fs "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fs "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1 || fail "后端 60 秒内未就绪，请查看上方 [server] 日志"

echo "==> 启动前端 http://localhost:$WEB_PORT"
(cd web && exec pnpm exec vite "${VITE_ARGS[@]}") 2>&1 | prefix web &

# Stop everything if either process exits, such as after a backend crash.
wait -n
