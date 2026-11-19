#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd -- "$project_dir"
if [[ $# == 1 && $1 == --systemd ]]; then
    cd -- runtime/current
    exec ./rawmark
fi
(( $# == 0 )) || { printf '用法：%s [--systemd]\n' "$0" >&2; exit 2; }
exec python3 scripts/native.py
