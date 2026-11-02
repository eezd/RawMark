#!/usr/bin/env bash
# Manage only this DEV instance under the deployment lock.
set -euo pipefail
if (( $# != 0 )); then
    printf '用法：bash %s\n' "$0" >&2
    exit 2
fi
instance_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd -- "$instance_dir"
for tool in docker flock env; do
    command -v "$tool" >/dev/null 2>&1 || { printf '缺少命令：%s\n' "$tool" >&2; exit 1; }
done
exec 9>>.deploy.lock
flock -n 9 || { printf '实例正在部署或启停，请稍后重试\n' >&2; exit 1; }
files=()
for filename in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
    [[ ! -f $filename ]] || files+=("$filename")
done
if (( ${#files[@]} != 1 )); then
    printf '实例必须有且只有一个 Compose 主文件，当前找到 %d 个\n' "${#files[@]}" >&2
    exit 1
fi
# Keep Docker client access; resolve application settings only from instance files.
compose=(env -i "PATH=$PATH")
for variable in HOME DOCKER_CONFIG DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH XDG_RUNTIME_DIR SSH_AUTH_SOCK; do
    if [[ -v $variable ]]; then
        compose+=("$variable=${!variable}")
    fi
done
compose+=(docker compose --project-directory "$instance_dir" -f "$instance_dir/${files[0]}")
# Explicit env files disable Compose's implicit .env, so include both in order.
for filename in .env images.env; do
    if [[ -f $filename ]]; then
        compose+=(--env-file "$instance_dir/$filename")
    fi
done
"${compose[@]}" config --quiet
# Preserve containers, networks, volumes and persistent data.
"${compose[@]}" stop
printf '已停止实例：%s\n' "${instance_dir##*/}"
