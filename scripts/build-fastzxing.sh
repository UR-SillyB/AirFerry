#!/usr/bin/env bash
# Build the self-compiled ZXing-C++ → WASM fast decoder (M3 fast path) and copy
# it into apps/web/src/fastzxing/ so the web/ext builds bundle it.
#
# Prereqs:
#   - Emscripten installed & on PATH (e.g. `source ~/emsdk/emsdk_env.sh`)
#   - Network for the first FetchContent clone of zxing-cpp (pinned commit)
#
# Usage:
#   ./scripts/build-fastzxing.sh
#   # reuse the Android build cache's zxing-src (no re-download):
#   ./scripts/build-fastzxing.sh --use-cache
set -euo pipefail
cd "$(dirname "$0")/.."

HERE="$(pwd)"
SRC="$HERE/core/zxing-decoder"
OUT="$HERE/apps/web/src/fastzxing"
BUILD="$SRC/build-wasm"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Activate Emscripten first (source ~/emsdk/emsdk_env.sh)." >&2
  exit 1
fi

EXTRA_CMAKE=()
if [[ "${1:-}" == "--use-cache" ]]; then
  CACHE_SRC="$HERE/apps/scanner/app/.cxx/Debug/3m4r2j6m/arm64-v8a/zxing-src"
  if [[ -d "$CACHE_SRC" ]]; then
    EXTRA_CMAKE=("-DZXING_SRC_DIR=$CACHE_SRC")
    echo "using cached zxing-cpp source: $CACHE_SRC"
  else
    echo "cache not found; will FetchContent download zxing-cpp" >&2
  fi
fi

echo "== configure (emcmake) =="
# Unconditionally wipe CMake configure cache files: on CI, the restored
# `build-wasm` cache tree retains the previous runner's temporary emsdk paths
# (which causes CMake 3.31+ to fail finding em++). Wiping CMakeCache.txt and
# CMakeFiles/ forces a fresh 1-second configure while preserving the expensive
# downloaded `_deps/` zxing-cpp source tree.
rm -rf "$BUILD/CMakeCache.txt" "$BUILD/CMakeFiles" "$BUILD/CopyOfCMakeCache.txt"
# `${EXTRA_CMAKE[@]+"${EXTRA_CMAKE[@]}"}` — expanding a possibly-empty array
# under `set -u` errors on macOS's stock bash 3.2 ("unbound variable"); the
# guard expands to nothing when the array is empty.
emcmake cmake -S "$SRC" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release ${EXTRA_CMAKE[@]+"${EXTRA_CMAKE[@]}"}

echo "== build =="
emmake cmake --build "$BUILD" -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

echo "== link =="
mkdir -p "$OUT"
"$SRC/link-wasm.sh" "$BUILD" "$OUT"

# Post-build integrity gate: the web receiver is FAST-only (the zxing-wasm
# fallback was removed), so a truncated/zero-byte artifact must fail HERE
# instead of at page load. Check both files exist, are non-trivially sized,
# and that the JS module really references the exported decoder entrypoint.
echo "== verify =="
for f in airferry_zxing.js airferry_zxing.wasm; do
  if [[ ! -s "$OUT/$f" ]]; then
    echo "error: $OUT/$f missing or empty" >&2
    exit 1
  fi
done
if ! grep -q "_airferry_wasm_decode_multi_y" "$OUT/airferry_zxing.js"; then
  echo "error: airferry_zxing.js does not export _airferry_wasm_decode_multi_y" >&2
  exit 1
fi
echo "FAST ZXing artifacts verified (js + wasm, decoder export present)"

echo "== done =="
ls -la "$OUT"
