#!/bin/sh
# Run project checks in the CI toolchain container.
set -eu

mode="${1:?Expected development or release}"
case "$mode" in development|release) ;; *) exit 2 ;; esac
export CGO_ENABLED=0
corepack enable
corepack prepare pnpm@12.11.2 --activate
pnpm -C web install --frozen-lockfile --registry=https://registry.npmjs.org
pnpm -C web lint:check
pnpm -C web typecheck
pnpm -C web test
pnpm -C web build
if [ "$mode" = release ]; then pnpm -C web build:demo; fi
go vet -tags dev ./...
go test ./internal/...
go test -tags dev ./web ./cmd/rawmark
go vet ./...
go test ./web ./cmd/rawmark
for package in vault watch; do
  go test -c -o "/tmp/rawmark-$package.test" "./internal/$package"
  (cd "internal/$package" && runuser -u node -- "/tmp/rawmark-$package.test" -test.v)
done
