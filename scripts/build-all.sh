#!/usr/bin/env bash
set -euo pipefail

# ====================================================================
# AirFerry 一键构建脚本
# 用法:
#   ./scripts/build-all.sh              # 构建全部（发送端 + 扫码端）
#   ./scripts/build-all.sh sender       # 仅构建浏览器发送端
#   ./scripts/build-all.sh scanner      # 仅构建 Android 扫码端
#   ./scripts/build-all.sh windows      # 仅构建 Windows 端（须在 Windows + .NET 8 SDK 下）
#   ./scripts/build-all.sh wasm         # 仅构建 Rust WASM
#   ./scripts/build-all.sh dist         # 仅打包：把已构建的产物复制/签名到 dist/
#   ./scripts/build-all.sh release      # 构建 + 打包到 dist/（发送 crx/xpi/zip + APK）
#
# 产物（dist/，均 git-ignored，通过 GitHub Release 分发）:
#   airferry-android-v<VER>.apk                 接收端 APK
#   airferry-windows-x64-v<VER>.zip             Windows 端（WPF + Rust DLL + OpenCV）
#   airferry-sender-chrome-mv3-v<VER>.crx       Chrome/Edge MV3（已签名 Cr24）
#   airferry-sender-chrome-mv3-v<VER>.zip       Chrome/Edge MV3（解压加载回退）
#   airferry-sender-chrome-mv2-v<VER>.crx       Chrome/Edge MV2（已签名 Cr24）
#   airferry-sender-chrome-mv2-v<VER>.zip
#   airferry-sender-firefox-mv3-v<VER>.xpi      Firefox MV3（zip→xpi）
#   airferry-sender-firefox-mv2-v<VER>.xpi
#   airferry-extension.pem                      Chrome 签名私钥（首次自动生成）
#
# 版本号取自 apps/sender/package.json，与扩展 manifest 一致。
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

# 从 apps/sender/package.json 读取版本号（与扩展 manifest.version 同源）。
read_version() {
  node -e "console.log(require('$ROOT/apps/sender/package.json').version)"
}
VER="$(read_version)"

# Chrome 二进制路径（macOS 标准安装位置）。找不到时跳过 crx 签名，仅留 zip。
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

build_wasm() {
  info "编译 Rust WASM 双产物 (legacy=0.2.92/标量 → wasm-pkg-legacy/, simd=0.2.125+SIMD → wasm-pkg-simd/) ..."
  cd "$ROOT/apps/sender"
  npm run wasm 2>&1 | tail -3
  info "WASM 双产物编译完成"
}

build_sender() {
  # npm run build already runs extract-lzma-wasm + build-wasm.cjs (both wasm
  # variants) + build-all.cjs (4 targets, swapping in the right variant per
  # MV2/MV3). No separate build_wasm call here — it would compile wasm twice.
  info "构建浏览器发送端 (Chrome MV3/MV2 + Firefox MV3/MV2) ..."
  cd "$ROOT/apps/sender"
  npm run build 2>&1 | grep -E 'DONE|Finished' | while read -r line; do info "$line"; done
  info "发送端构建完成 → apps/sender/build/"
}

build_scanner() {
  info "构建 Android 扫码端 ..."

  # 先编译 Rust JNI 库 (libtransfer_engine.so) 到 jniLibs/。
  # 这一步必须在 gradlew 之前：APK 打包时直接拷贝 jniLibs/ 里的 .so，
  # 不会触发 cargo。若跳过这步，APK 里会带着过期的 .so（比如 EasyTransfer
  # 重命名为 AirFerry 后，旧 .so 的 JNI 符号还是 com.easytransfer.*，
  # 运行时 receiverCreate 抛 UnsatisfiedLinkError 直接闪退）。
  # 详见 docs/build-android.md。
  info "编译 Rust JNI 库 (core/transfer-engine --features jni → jniLibs/arm64-v8a/) ..."
  cargo ndk -t arm64-v8a -o "$ROOT/apps/scanner/app/src/main/jniLibs" \
    build -p transfer-engine --features jni --release 2>&1 | tail -3
  info "JNI 库编译完成 → apps/scanner/app/src/main/jniLibs/arm64-v8a/libtransfer_engine.so"

  cd "$ROOT/apps/scanner"
  ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  ./gradlew assembleRelease 2>&1 | tail -3 | while read -r line; do info "$line"; done
  info "扫码端构建完成 → apps/scanner/app/build/outputs/apk/release/app-release.apk"
}

build_windows() {
  info "构建 Windows 端 (WPF + Rust DLL) ..."

  # 先编译 Rust C ABI 库 (transfer_engine.dll) 到 C# runtime/。
  # 这一步必须在 dotnet build 之前：csproj 把 runtime/transfer_engine.dll
  # 标为 CopyToOutputDirectory，若缺失，dotnet build 会带空引用导致运行时
  # DllNotFoundException（对标 Android 的 jniLibs 缺 .so 问题）。
  info "编译 Rust C ABI (core/transfer-engine --features cffi → transfer_engine.dll) ..."
  cargo build -p transfer-engine --features cffi --release 2>&1 | tail -3

  local runtime_dir="$ROOT/apps/windows/AirFerry.Windows/runtime"
  mkdir -p "$runtime_dir"
  local dll_src
  # Linux/macOS 产物是 libtransfer_engine.{so,dylib}，Windows 是 transfer_engine.dll。
  # 仅在 Windows 上构建时产物才会是 .dll（这里构建主机须为 Windows）。
  dll_src="$ROOT/target/release/transfer_engine.dll"
  if [[ ! -f "$dll_src" ]]; then
    # 回退：当前主机非 Windows，Rust 产物可能是 .so/.dylib。在非 Windows 上
    # 这步会失败——Windows 端只能在 Windows 主机上完整构建。
    dll_src="$(ls "$ROOT/target/release/"libtransfer_engine.{dll,so,dylib} 2>/dev/null | head -1 || true)"
    if [[ -z "$dll_src" ]]; then
      error "未找到 transfer_engine 产物。Windows 端必须在 Windows 主机上用 PowerShell 脚本构建: ./scripts/build-windows.ps1"
    fi
    warn "当前主机非 Windows，Rust 产物为 $(basename "$dll_src")（仅供 Rust 层冒烟测试，C# 端无法在非 Windows 上构建 WPF）"
  fi
  cp "$dll_src" "$runtime_dir/transfer_engine.dll"
  info "Rust DLL → apps/windows/AirFerry.Windows/runtime/transfer_engine.dll"

  # 构建 C# WPF（须 Windows + .NET 8 SDK）。在非 Windows 上 dotnet build
  # 会因 net8.0-windows TFM 失败——首选 scripts/build-windows.ps1。
  if ! command -v dotnet >/dev/null 2>&1; then
    error "未找到 dotnet。Windows 端请在 Windows 上运行: ./scripts/build-windows.ps1"
  fi
  (cd "$ROOT/apps/windows" && dotnet build -c Release 2>&1 | tail -5 | while read -r line; do info "$line"; done)
  info "Windows 端构建完成 → apps/windows/AirFerry.Windows/bin/x64/Release/"
}

# 打包 Chrome MV2/MV3 为已签名 .crx。
#
# Chrome --pack-extension 在「未给 --pack-extension-key」时会新生成一个
# <dir>.pem 私钥；首次运行我们把它挪到 dist/airferry-extension.pem，之后
# MV2/MV3 复用同一私钥 → 扩展 ID 稳定，便于升级替换。
pack_chrome_crx() {
  local prod_dir="$1"   # 如 chrome-mv3-prod
  local plat="${prod_dir%-prod}"   # chrome-mv3
  local key="$ROOT/dist/airferry-extension.pem"

  if [[ ! -x "$CHROME_BIN" ]]; then
    warn "未找到 Chrome（$CHROME_BIN），跳过 ${plat} 的 .crx 签名，仅保留 .zip"
    return 0
  fi

  if [[ -f "$key" ]]; then
    # 复用已有私钥，保证扩展 ID 与历史一致。
    "$CHROME_BIN" --pack-extension="$ROOT/apps/sender/build/$prod_dir" \
                  --pack-extension-key="$key" >/dev/null 2>&1 || {
      warn "${plat} 的 .crx 打包失败，仅保留 .zip"
      return 0
    }
  else
    # 首次：让 Chrome 生成私钥，再挪到固定位置。
    "$CHROME_BIN" --pack-extension="$ROOT/apps/sender/build/$prod_dir" >/dev/null 2>&1 || {
      warn "${plat} 的 .crx 打包失败，仅保留 .zip"
      return 0
    }
    mv "$ROOT/apps/sender/build/${prod_dir}.pem" "$key" 2>/dev/null || true
    info "已生成 Chrome 签名私钥 → dist/airferry-extension.pem（请妥善保管）"
  fi

  # Chrome 把 .crx 产物写到 build/<prod_dir>.crx，搬到 dist 并按规范命名。
  mv "$ROOT/apps/sender/build/${prod_dir}.crx" \
     "$ROOT/dist/airferry-sender-${plat}-v${VER}.crx"
  info "发送端 ${plat} → dist/airferry-sender-${plat}-v${VER}.crx"
}

# 仅打包：假设 apps/sender/build/ 与 APK 已构建好，把它们复制/签名到 dist/。
pack_dist() {
  info "打包产物到 dist/（版本 v${VER}）..."
  mkdir -p "$ROOT/dist"
  # 清掉旧产物，避免新旧版本/命名混留（pem / keystore 不动）。
  rm -f "$ROOT/dist"/airferry-android-*.apk \
        "$ROOT/dist"/airferry-windows-*.zip \
        "$ROOT/dist"/airferry-sender-*.crx \
        "$ROOT/dist"/airferry-sender-*.zip \
        "$ROOT/dist"/airferry-sender-*.xpi \
        "$ROOT/dist"/airferry-chrome-*.crx \
        "$ROOT/dist"/airferry-chrome-*.zip \
        "$ROOT/dist"/airferry-firefox-*.xpi

  # 扫码端 APK
  local apk_src="$ROOT/apps/scanner/app/build/outputs/apk/release/app-release.apk"
  [[ -f "$apk_src" ]] || error "找不到 APK：$apk_src（先运行 build-all.sh scanner）"
  cp "$apk_src" "$ROOT/dist/airferry-android-v${VER}.apk"
  info "APK → dist/airferry-android-v${VER}.apk"

  # Windows 端 zip（仅当已构建时打包——Windows 端须在 Windows 上构建）
  local win_publish="$ROOT/apps/windows/AirFerry.Windows/bin/x64/Release/net8.0-windows/publish"
  if [[ -d "$win_publish" ]]; then
    ( cd "$win_publish" && zip -r -q -X "$ROOT/dist/airferry-windows-x64-v${VER}.zip" . )
    info "Windows 端 → dist/airferry-windows-x64-v${VER}.zip"
  else
    warn "未找到 Windows 端构建产物（$win_publish）。如需打包 Windows 端，先在 Windows 上运行: ./scripts/build-windows.ps1 release"
  fi

  # 发送端：Chrome crx + zip，Firefox xpi（即 zip 改名）
  for target in chrome-mv3-prod chrome-mv2-prod firefox-mv3-prod firefox-mv2-prod; do
    local prod_dir="$target"
    local plat="${prod_dir%-prod}"
    local src_dir="$ROOT/apps/sender/build/$prod_dir"
    [[ -d "$src_dir" ]] || error "找不到发送端构建：$src_dir（先运行 build-all.sh sender）"

    if [[ "$plat" == chrome-* ]]; then
      # Chrome/Edge：签名 crx + 解压加载用的 zip
      pack_chrome_crx "$prod_dir"
      ( cd "$src_dir" && zip -r -q -X "$ROOT/dist/airferry-sender-${plat}-v${VER}.zip" . )
      info "发送端 ${plat} → dist/airferry-sender-${plat}-v${VER}.zip"
    else
      # Firefox：xpi 本质就是 zip，直接打包并改名
      ( cd "$src_dir" && zip -r -q -X "$ROOT/dist/airferry-sender-${plat}-v${VER}.xpi" . )
      info "发送端 ${plat} → dist/airferry-sender-${plat}-v${VER}.xpi"
    fi
  done

  info "全部产物已打包到 dist/（版本 v${VER}）"
}

build_release() {
  info "构建全部 + 打包到 dist/ ..."
  build_sender
  build_scanner
  pack_dist
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
  windows)
    build_windows
    ;;
  wasm)
    build_wasm
    ;;
  dist)
    pack_dist
    ;;
  release)
    build_release
    ;;
  *)
    echo "用法: $0 [all|sender|scanner|windows|wasm|dist|release]"
    echo "  windows 子命令须在 Windows + .NET 8 SDK 下运行（或用 scripts/build-windows.ps1）"
    exit 1
    ;;
esac

info "构建完成!"
