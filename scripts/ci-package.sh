#!/bin/sh
# Package the same binaries used by native and container smoke tests.
set -eu
mode="${1:?Expected development or release}"
case "$mode" in
  development) targets='linux/amd64' ;;
  release) targets='linux/amd64 linux/arm64 windows/amd64 windows/arm64 darwin/amd64 darwin/arm64' ;;
  *) exit 2 ;;
esac
export RAWMARK_BUILD_CHANNEL="$mode"
export RAWMARK_BUILD_VERSION="$(python3 scripts/release.py version)"
export CGO_ENABLED=0
mkdir -p package/licenses downloads
cp LICENSE package/
cp web/LICENSE package/licenses/vue3-starter-MIT.txt
cp web/src/common/appearance/fonts/*-OFL.txt package/licenses/
cp web/src/common/appearance/fonts/maple/LICENSE.txt package/licenses/Maple-Mono-OFL.txt
for target in $targets; do
  export GOOS="${target%/*}" GOARCH="${target#*/}"
  extension=''
  if [ "$GOOS" = windows ]; then extension='.exe'; fi
  rm -f package/rawmark package/rawmark.exe
  go vet ./...
  go build -trimpath -ldflags="-s -w -X main.releaseVersion=$(python3 scripts/release.py version)" \
    -o "package/rawmark$extension" ./cmd/rawmark
  if [ "$target" = linux/amd64 ]; then python3 scripts/smoke-release.py package/rawmark; fi
  python3 scripts/package-release.py "$GOOS" "$GOARCH"
done
python3 scripts/release.py bundle "$mode"
