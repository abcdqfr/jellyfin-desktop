#!/bin/sh
# Run the in-tree `build/jellyfin-desktop` with the same library path as a local build
# (libmpv in build/, libplacebo in ~/.local/jellyfin-build-deps if used for the mpv build).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export LD_LIBRARY_PATH="$ROOT/build:${HOME}/.local/jellyfin-build-deps/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
exec "$ROOT/build/jellyfin-desktop" "$@"
