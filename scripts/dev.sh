#!/usr/bin/env bash
# 一键启动开发环境：Go 后端（go run -tags dev）+ Vite 前端（热更新），Ctrl+C 同时退出。
#
# 用法：scripts/dev.sh [--host]
#   --host  前端监听所有网卡，便于手机/平板通过局域网访问
#
# 环境变量：
#   RAWMARK_DATA  开发数据目录，默认 <仓库>/.dev-data
#   API_PORT      后端端口，默认 8080（Vite 代理读取同一变量）
#   WEB_PORT      前端端口，默认 5173
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

# Go 默认安装位置可能不在非登录 shell 的 PATH 中
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

# 由 pnpm 核对锁定依赖；已有依赖时复用本地缓存。
echo "==> 核对前端依赖"
pnpm -C web install --frozen-lockfile

# 退出时结束本脚本启动的所有子进程（包括 go run 编译出的服务进程）
cleanup() {
  trap - EXIT INT TERM
  echo
  echo "==> 正在停止"
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 给两路日志加前缀，便于区分
prefix() { sed -u "s/^/[$1] /"; }

echo "==> 启动后端 http://127.0.0.1:$API_PORT（数据目录 $RAWMARK_DATA）"
RAWMARK_ADDR="127.0.0.1:$API_PORT" go run -tags dev ./cmd/rawmark 2>&1 | prefix server &

# 等后端就绪后再启动前端，避免首次编译期间前端请求失败
for _ in $(seq 1 120); do
  curl -fs "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fs "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1 || fail "后端 60 秒内未就绪，请查看上方 [server] 日志"

echo "==> 启动前端 http://localhost:$WEB_PORT"
(cd web && exec pnpm exec vite "${VITE_ARGS[@]}") 2>&1 | prefix web &

# 任一进程退出（如后端崩溃）即整体停止
wait -n
