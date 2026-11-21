#!/bin/sh
# Run project checks in the CI toolchain container.
set -eu

mode="${1:?Expected development or release}"
case "$mode" in development|release) ;; *) exit 2 ;; esac
export RAWMARK_BUILD_CHANNEL="$mode"
export RAWMARK_BUILD_VERSION="$(python3 scripts/release.py version)"
export CGO_ENABLED=0
env -u RAWMARK_BUILD_VERSION -u RAWMARK_BUILD_CHANNEL -u RAWMARK_BUILD_SHA python3 -m unittest discover -s scripts/tests -v
pnpm -C web install --frozen-lockfile --registry=https://registry.npmjs.org
pnpm -C web lint:check
pnpm -C web typecheck
# Bound concurrent transforms in the Runner without relaxing test deadlines.
pnpm -C web test --maxWorkers=2
pnpm -C web build
if [ "$mode" = release ]; then pnpm -C web build:demo; fi
go vet -tags dev ./...
go test ./internal/...
go test -tags dev ./web ./cmd/rawmark
go vet ./...
go test ./web ./cmd/rawmark
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/rawmark-permissions.XXXXXXXX")
trap 'rm -rf -- "$test_dir"' EXIT
chmod 711 "$test_dir"
for package in vault watch; do
  test_binary="$test_dir/$package.test"
  go test -c -o "$test_binary" "./internal/$package"
  if [ "$(id -u)" -eq 0 ]; then
    chmod 755 "$test_binary"
    # Test permissions without relying on an account in the host or CI image.
    (cd "internal/$package" && setpriv --reuid 65534 --regid 65534 --clear-groups -- "$test_binary" -test.v)
  else
    (cd "internal/$package" && "$test_binary" -test.v)
  fi
done
