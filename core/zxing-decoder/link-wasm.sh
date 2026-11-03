#!/usr/bin/env bash
# Link the built static libs (airferry_zxing.a + libZXing.a) into the browser
# WASM module: airferry_zxing.js (ES6 glue) + airferry_zxing.wasm.
#
# Usage: ./link-wasm.sh <build-dir> [output-dir]
#   build-dir   : emcmake build dir (contains libairferry_zxing.a + libZXing.a)
#   output-dir  : where to write airferry_zxing.js/.wasm (default: current dir)
set -euo pipefail

BUILD_DIR="${1:?usage: link-wasm.sh <build-dir> [output-dir]}"
OUT_DIR="${2:-$PWD}"
ZXING_LIB="$BUILD_DIR/_deps/zxing-build/core/libZXing.a"

if [[ ! -f "$BUILD_DIR/libairferry_zxing.a" || ! -f "$ZXING_LIB" ]]; then
  echo "error: static libs not found in $BUILD_DIR (run emcmake configure + build first)" >&2
  exit 1
fi

# Fixed 64 MiB heap, growth DISABLED: a 1080p Y plane (~2 MB) + ZXing's internal
# allocations can grow the default 16 MiB heap, which detaches JS-visible
# HEAPU8/HEAPU32 views and made the fast backend fail on real camera frames
# ("扫不出来"). A fixed heap keeps the views valid for the whole module lifetime.
# Fixed 64 MiB heap (views stay valid) + a large 1 MiB stack: ZXing-C++ recurses
# on big frames (1080p QR), and the default 64 KiB stack overflowed → a WASM trap
# that the JS layer saw as a numeric exception ("解码失败: 638680"), breaking the
# fast backend on real camera frames ("扫不出来"). `-s STACK_SIZE=1MiB` fixes it.
# -fexceptions: ZXing-C++ throws on some big/partial frames; without exception
# support emscripten traps and JS sees a numeric exception ("解码失败: 638680").
# Enabling exceptions lets our wrapper's catch(...) swallow it and return nullptr
# gracefully (the frame is just skipped) instead of breaking the whole backend.
em++ -O3 -std=c++20 -fexceptions \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker \
  -s INITIAL_MEMORY=67108864 -s ALLOW_MEMORY_GROWTH=0 \
  -s STACK_SIZE=1048576 \
  -s EXPORTED_FUNCTIONS=_airferry_wasm_decode_multi_y,_airferry_wasm_free,_airferry_wasm_abi_version,_malloc,_free \
  -s EXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAPU32 \
  "$BUILD_DIR/libairferry_zxing.a" "$ZXING_LIB" \
  -o "$OUT_DIR/airferry_zxing.js"

echo "wrote: $OUT_DIR/airferry_zxing.js (+ airferry_zxing.wasm)"
