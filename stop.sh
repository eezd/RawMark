#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd -- "$project_dir"
# systemd sends SIGTERM to the foreground Go process for graceful shutdown.
if [[ $# == 1 && $1 == --systemd ]]; then
    exit 0
fi
(( $# == 0 )) || { printf '用法：%s [--systemd]\n' "$0" >&2; exit 2; }
services=('rawmark-dev.service')
command -v flock >/dev/null || { printf '缺少命令：flock\n' >&2; exit 1; }
command -v systemctl >/dev/null || { printf '缺少命令：systemctl\n' >&2; exit 1; }
[[ -d runtime ]] || { printf '项目尚未部署，缺少 runtime 目录\n' >&2; exit 1; }
exec 9>>runtime/.deploy.lock
flock -n 9 || { printf '项目正在构建或启停，请稍后重试\n' >&2; exit 1; }
systemctl stop -- "${services[@]}"
printf '已停止项目：%s\n' "${project_dir##*/}"
