#!/usr/bin/env bash
set -euo pipefail

# ====================================================================
# AirFerry 一键构建脚本
# 用法:
#   ./scripts/build-all.sh              # 构建全部（发送端 + 扫码端）
#   ./scripts/build-all.sh sender       # 仅构建浏览器发送端
#   ./scripts/build-all.sh scanner      # 仅构建 Android 扫码端
#   ./scripts/build-all.sh wasm         # 仅构建 Rust WASM
#   ./scripts/build-all.sh release      # 构建 + 打包到 dist/
# ====================================================================

cd "$(dirname "$0")/.."
ROOT="$PWD"

# 颜色输出
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# 目标列表
TARGET="${1:-all}"

build_wasm() {
  info "编译 Rust WASM (core/transfer-engine → sender/wasm-pkg/) ..."
  cd "$ROOT/apps/sender"
  npm run wasm 2>&1 | tail -3
  info "WASM 编译完成"
}

build_sender() {
  build_wasm
  info "构建浏览器发送端 (Chrome MV3/MV2 + Firefox MV3/MV2) ..."
  cd "$ROOT/apps/sender"
  npm run build 2>&1 | grep -E 'DONE|Finished' | while read -r line; do info "$line"; done
  info "发送端构建完成 → apps/sender/build/"
}

build_scanner() {
  info "构建 Android 扫码端 ..."
  cd "$ROOT/apps/scanner"
  ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  ./gradlew assembleRelease 2>&1 | tail -3 | while read -r line; do info "$line"; done
  info "扫码端构建完成 → apps/scanner/app/build/outputs/apk/release/app-release.apk"
}

build_release() {
  info "构建全部 + 打包到 dist/ ..."
  build_sender
  build_scanner

  mkdir -p "$ROOT/dist"

  # 扫码端 APK
  cp "$ROOT/apps/scanner/app/build/outputs/apk/release/app-release.apk" \
     "$ROOT/dist/airferry-android-v1.1.0.apk"
  info "APK → dist/airferry-android-v1.1.0.apk"

  # 发送端 zip
  cd "$ROOT/apps/sender/build"
  rm -f "$ROOT/dist"/airferry-sender-*.zip
  for target in chrome-mv3-prod chrome-mv2-prod firefox-mv3-prod firefox-mv2-prod; do
    plat="${target%-prod}"
    zip -r -q "$ROOT/dist/airferry-sender-${plat}.zip" "$target/"
    info "发送端 ${plat} → dist/airferry-sender-${plat}.zip"
  done

  info "全部构建产物已打包到 dist/"
}

case "$TARGET" in
  all)
    build_sender
    build_scanner
    ;;
  sender)
    build_sender
    ;;
  scanner)
    build_scanner
    ;;
  wasm)
    build_wasm
    ;;
  release)
    build_release
    ;;
  *)
    echo "用法: $0 [all|sender|scanner|wasm|release]"
    exit 1
    ;;
esac

info "构建完成!"
