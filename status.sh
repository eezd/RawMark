#!/usr/bin/env bash
set -euo pipefail
(( $# == 0 )) || { printf '用法：bash %s\n' "$0" >&2; exit 2; }
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
services=('rawmark-dev.service')
[[ ${services[*]} != *'@@'* ]] || { printf '尚未配置项目 systemd unit\n' >&2; exit 1; }
command -v systemctl >/dev/null || { printf '缺少命令：systemctl\n' >&2; exit 1; }
result=0
systemctl --no-pager --full status -- "${services[@]}" || result=$?
if [[ -f "$project_dir/runtime/current/build.json" ]]; then
    cat -- "$project_dir/runtime/current/build.json"
else
    printf '没有本地构建记录\n'
fi
exit "$result"
