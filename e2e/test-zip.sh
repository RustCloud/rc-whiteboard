#!/bin/sh
# The plugin archive for e2e: the real one, but [[open_with]] also takes
# application/octet-stream. The panel of RustCloud API 0.2.17 matches the
# file it opens by mime alone, not by `extensions` (docs/core-tasks.md), and
# the server gives .excalidraw files that type.
#   e2e/test-zip.sh <folder with manifest.toml and app.wasm> <out.zip>
set -eu
src=$1
out=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/rc-whiteboard"
cp "$src/app.wasm" "$tmp/rc-whiteboard/"
sed 's|^mime = \["application/vnd.excalidraw+json"\]$|mime = ["application/vnd.excalidraw+json", "application/octet-stream"]|' \
  "$src/manifest.toml" > "$tmp/rc-whiteboard/manifest.toml"
grep -q 'application/octet-stream"]' "$tmp/rc-whiteboard/manifest.toml" || { echo "mime line not found in manifest.toml" >&2; exit 1; }
rm -f "$out"
(cd "$tmp" && zip -qr "$out" rc-whiteboard)
