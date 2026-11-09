#!/usr/bin/env bash
set -euo pipefail
(( $# == 0 )) || { printf '用法：bash %s\n' "$0" >&2; exit 2; }
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec python3 scripts/native.py start
