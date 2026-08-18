#!/usr/bin/env bash
set -euo pipefail

# ====================================================================
# AirFerry 一键构建脚本
# 用法:
#   ./scripts/build-all.sh              # 构建全部（发送端 + 扫码端）
#   ./scripts/build-all.sh sender       # 仅构建浏览器发送端
#   ./scripts/build-all.sh scanner      # 仅构建 Android 扫码端
#   ./scripts/build-all.sh windows      # 仅构建 Windows 端（须 Windows + .NET 8 SDK + CMake/VS C++）
#   ./scripts/build-all.sh wasm         # 仅构建 Rust WASM
#   ./scripts/build-all.sh dist         # 仅打包：把已构建的产物复制/签名到 dist/
#   ./scripts/build-all.sh dist-upload-list  # 打印可安全上传到 Release 的产物清单（排除密钥）
#   ./scripts/build-all.sh release      # 构建 + 打包到 dist/（发送 crx/xpi/zip + APK）
#
# 产物（dist/，均 git-ignored，通过 GitHub Release 分发）:
#   airferry-receiver-android-arm64-v<VER>.apk  Android 接收端 APK
#   airferry-receiver-windows-x64-v<VER>.zip    Windows 接收端（WPF + Rust/ZXing-C++ DLL + OpenCV）
#   airferry-sender-chrome-mv3-v<VER>.crx       Chrome/Edge MV3（已签名 Cr24）
#   airferry-sender-chrome-mv3-v<VER>.zip       Chrome/Edge MV3（解压加载回退）
#   airferry-sender-chrome-mv2-v<VER>.crx       Chrome/Edge MV2（已签名 Cr24）
#   airferry-sender-chrome-mv2-v<VER>.zip
#   airferry-sender-firefox-mv3-v<VER>.xpi      Firefox MV3（zip→xpi）
#   airferry-sender-firefox-mv2-v<VER>.xpi
#   airferry-sender-web-v<VER>.zip              网页发送端静态站点
#   airferry-receiver-web-v<VER>.zip            网页接收端静态站点（receiver.html）
#   airferry-sender-web-standalone-v<VER>.html  网页发送端单文件版（双击即用，file:// 可运行）
#   airferry-extension.pem                      Chrome 签名私钥（须预先配置）
#
# ⚠️ 上传 Release 切勿用裸 `gh release upload ... dist/*`：dist/ 同时存放
#   airferry-extension.pem 与 airferry-release.keystore，裸通配会把密钥一并
#   上传造成外泄。始终用 `$(./scripts/build-all.sh dist-upload-list)` 取扩展名
#   白名单清单（仅 .apk/.zip/.crx/.xpi/.html，物理上排除了密钥）。
#
# 版本号规范：
#   • 唯一来源：apps/web/package.json 的 version（read_version() 读取），
#     扩展 manifest 同步；改版本只改这一处。
#   • 产物统一命名 airferry-<端>-<平台>-v<VER>.<ext>，VER 即该来源版本号。
#   • 手动同步项（无自动派生，改版本时须同步）：
#       - apps/scanner/app/build.gradle.kts  versionCode/versionName
#       - apps/web/package.json               version
#       - apps/windows/.../AssemblyInfo       版本
#   • Android versionCode 需随版本递增（1.2.0 → 14），versionName 与 VER 一致。
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

# 从 apps/web/package.json 读取版本号（与扩展 manifest.version 同源）。
read_version() {
  node -e "console.log(require('$ROOT/apps/web/package.json').version)"
}
VER="$(read_version)"

# Chrome 二进制：允许显式 CHROME_BIN 覆盖，并自动探测 macOS/Linux 常见路径。
# 普通 `dist` 可以在无签名环境只产 zip；`release` 必须 fail-closed 产出 CRX。
CHROME_BIN="${CHROME_BIN:-}"
REQUIRE_SIGNED_ARTIFACTS="${AIRFERRY_REQUIRE_SIGNED_RELEASE:-0}"
if [[ "$TARGET" == "release" ]]; then
  REQUIRE_SIGNED_ARTIFACTS=1
fi
EXPECTED_ANDROID_CERT_SHA256="44577EDA2C6D4F44638C9D61DC161F08FDB30FCEE6A3410AADAEB7CE65A97FDD"
EXPECTED_CHROME_PUBLIC_KEY_SHA256="b6059f0bf2184bbdb153013b15eee99cf8176fd653e46fcda4123868a05e2986"

detect_chrome_bin() {
  if [[ -n "$CHROME_BIN" && -x "$CHROME_BIN" ]]; then
    return 0
  fi
  local candidate=""
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/usr/bin/google-chrome-stable" \
    "/usr/bin/google-chrome" \
    "/usr/bin/chromium" \
    "/usr/bin/chromium-browser"; do
    if [[ -x "$candidate" ]]; then
      CHROME_BIN="$candidate"
      return 0
    fi
  done
  return 1
}

verify_apk_signature() {
  local apk="$1"
  local apksigner_bin=""
  if command -v apksigner >/dev/null 2>&1; then
    apksigner_bin="$(command -v apksigner)"
  else
    local sdk_root=""
    local sdk_candidates=(
      "${ANDROID_HOME:-}"
      "${ANDROID_SDK_ROOT:-}"
      "$HOME/Android/Sdk"
      "$HOME/Library/Android/sdk"
    )
    local candidate
    for candidate in "${sdk_candidates[@]}"; do
      if [[ -n "$candidate" && -d "$candidate/build-tools" ]]; then
        sdk_root="$candidate"
        break
      fi
    done
    if [[ -n "$sdk_root" ]]; then
      # Lexicographic ordering is portable across BSD/GNU sort and is
      # sufficient for Android build-tools' fixed-width modern versions.
      apksigner_bin="$(find "$sdk_root/build-tools" -type f -name apksigner 2>/dev/null | sort | tail -1 || true)"
    fi
  fi
  if [[ -z "$apksigner_bin" ]]; then
    error "未找到 apksigner，无法验证 APK 发布证书；拒绝打包: $apk"
  fi
  local cert_info
  cert_info="$("$apksigner_bin" verify --verbose --print-certs "$apk")" || \
    error "APK 签名验证失败: $apk"
  if grep -qiE 'CN=Android Debug|Android Debug' <<<"$cert_info"; then
    error "检测到 Android debug 签名，拒绝发布: $apk"
  fi
  local actual_sha
  actual_sha="$(sed -n 's/^Signer #1 certificate SHA-256 digest: //p' <<<"$cert_info" | head -1 | tr '[:lower:]' '[:upper:]')"
  [[ -n "$actual_sha" ]] || error "无法读取 APK 签名证书指纹"
  if [[ "$actual_sha" != "$EXPECTED_ANDROID_CERT_SHA256" ]]; then
    error "APK 签名证书不是 AirFerry 固定发布证书（实际: $actual_sha）"
  fi
  info "APK 签名已验证 (SHA-256: $actual_sha)"
}

build_wasm() {
  info "编译 Rust WASM 单产物 (wasm-bindgen=0.2.92/标量 → wasm-pkg/) ..."
  cd "$ROOT/apps/web"
  npm run wasm 2>&1 | tail -3
  info "WASM 产物编译完成"
}

build_sender() {
  info "构建浏览器发送端 (Chrome MV3/MV2 + Firefox MV3/MV2) ..."
  cd "$ROOT/apps/web"
  npm run build:ext 2>&1 | grep -E 'built in|Building target|All targets built' | while read -r line; do info "$line"; done
  WASM_BUILT=1
  info "发送端构建完成 → apps/web/build/"
}

build_scanner() {
  info "构建 Android 扫码端 ..."
  [[ ! -f "$ROOT/apps/scanner/keystore.properties" ]] || chmod 600 "$ROOT/apps/scanner/keystore.properties"
  [[ ! -f "$ROOT/dist/airferry-release.keystore" ]] || chmod 600 "$ROOT/dist/airferry-release.keystore"

  # 设置 Android SDK / NDK 环境变量（cargo-ndk 需要 ANDROID_NDK_HOME）。
  # 优先使用用户已设的值，否则按常见路径自动探测。
  local sdk_candidates=(
    "${ANDROID_HOME:-}"
    "${ANDROID_SDK_ROOT:-}"
    "$HOME/Android/Sdk"
    "$HOME/Library/Android/sdk"
    "/opt/homebrew/share/android-commandlinetools"
  )
  local android_home=""
  for p in "${sdk_candidates[@]}"; do
    if [ -n "$p" ] && [ -d "$p/ndk" ]; then
      android_home="$p"
      break
    fi
  done
  if [ -z "$android_home" ]; then
    error "找不到 Android SDK（需含 ndk/ 子目录）。请设置 ANDROID_HOME 或 ANDROID_NDK_HOME 环境变量。"
    return 1
  fi
  ANDROID_HOME="$android_home"
  ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk}"
  export ANDROID_HOME ANDROID_NDK_HOME

  # Rust JNI 库 (libtransfer_engine.so) 由 Gradle 的 compileRustJni task
  # （merge*JniLibFolders 的前置，debug/release 均生效）在 assembleRelease 时
  # 编译到 jniLibs/，此处不再显式跑 cargo-ndk（避免每次 release 双重编译）。
  # 详见 docs/build-android.md。

  cd "$ROOT/apps/scanner"
  ./gradlew assembleRelease 2>&1 | tail -3 | while read -r line; do info "$line"; done
  verify_apk_signature "$ROOT/apps/scanner/app/build/outputs/apk/release/app-release.apk"
  info "扫码端构建完成 → apps/scanner/app/build/outputs/apk/release/app-release.apk"
}

build_windows() {
  info "构建 Windows 端 (WPF + Rust DLL + ZXing-C++ DLL) ..."

  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *) error "Windows 端只能在 Windows 主机上构建；请运行 scripts/build-windows.ps1" ;;
  esac

  # 先编译 Rust C ABI 库 (transfer_engine.dll) 到 C# runtime/。
  # 这一步必须在 dotnet build 之前：csproj 把 runtime/transfer_engine.dll
  # 标为 CopyToOutputDirectory，若缺失，dotnet build 会带空引用导致运行时
  # DllNotFoundException（对标 Android 的 jniLibs 缺 .so 问题）。
  info "编译 Rust C ABI (core/transfer-engine --features cffi → transfer_engine.dll) ..."
  cargo build -p transfer-engine --features cffi --release 2>&1 | tail -3

  local runtime_dir="$ROOT/apps/windows/AirFerry.Windows/runtime"
  mkdir -p "$runtime_dir"
  local dll_src="$ROOT/target/release/transfer_engine.dll"
  [[ -f "$dll_src" ]] || error "未找到真实的 Windows DLL: $dll_src"
  cp "$dll_src" "$runtime_dir/transfer_engine.dll"
  info "Rust DLL → apps/windows/AirFerry.Windows/runtime/transfer_engine.dll"

  # 与 Android 共用同一个 ZXing-C++ 解码核心；Windows C ABI 包装器产出
  # airferry_zxing.dll。首次配置会按固定 commit 获取 zxing-cpp 源码。
  command -v cmake >/dev/null 2>&1 || error "未找到 CMake 3.22+"
  local native_src="$ROOT/apps/windows/native"
  local native_build="$native_src/build"
  cmake -S "$native_src" -B "$native_build" \
    -G "Visual Studio 17 2022" -A x64 >/dev/null
  cmake --build "$native_build" --config Release --parallel 2>&1 | tail -5
  ctest --test-dir "$native_build" -C Release --output-on-failure
  local zxing_dll
  zxing_dll="$(find "$native_build" -type f -name airferry_zxing.dll | head -1 || true)"
  [[ -n "$zxing_dll" ]] || error "未找到 airferry_zxing.dll"
  cp "$zxing_dll" "$runtime_dir/airferry_zxing.dll"
  info "ZXing-C++ DLL → apps/windows/AirFerry.Windows/runtime/airferry_zxing.dll"

  # 构建 C# WPF（须 Windows + .NET 8 SDK）。在非 Windows 上 dotnet build
  # 会因 net8.0-windows TFM 失败——首选 scripts/build-windows.ps1。
  if ! command -v dotnet >/dev/null 2>&1; then
    error "未找到 dotnet。Windows 端请在 Windows 上运行: ./scripts/build-windows.ps1"
  fi
  (cd "$ROOT/apps/windows" && dotnet build -c Release 2>&1 | tail -5 | while read -r line; do info "$line"; done)
  info "Windows 端构建完成 → apps/windows/AirFerry.Windows/bin/x64/Release/"
}

build_web() {
  info "构建网页端 — 发送端 dist/ + 接收端 dist-receiver/（各自独立 zip）..."

  # 保证 web 打包的每个原生 lib 都来自最新源码，而非复用旧的中间产物：
  #  ① Rust WASM（transfer_engine_bg.wasm）— 单独跑 build_web 时重编 wasm-pkg/
  #     （prepare-wasm.cjs 只校验存在、不校验 freshness）；all/release 流程里
  #     build_sender 的 `npm run build` 已编译过，直接跳过。
  #  ② FAST ZXing-C++（airferry_zxing.js/.wasm）— emcc 可用时重编，防止 build-all.sh
  #     从不调用 build-fastzxing.sh 而把上一次遗留的旧 .wasm 打进接收端；emcc
  #     缺失即失败（FAST-only，zxing-wasm 回退已移除）。
  if [[ -z "${WASM_BUILT:-}" ]]; then
    build_wasm
  fi
  if command -v emcc >/dev/null 2>&1; then
    info "重编 FAST ZXing-C++ 快路径 (airferry_zxing.js/.wasm → apps/web/src/fastzxing/) ..."
    "$ROOT/scripts/build-fastzxing.sh" --use-cache
  elif [[ -f "$ROOT/apps/web/src/fastzxing/airferry_zxing.js" && -f "$ROOT/apps/web/src/fastzxing/airferry_zxing.wasm" ]]; then
    info "复用现有 FAST ZXing-C++ 缓存产物 (airferry_zxing.js/.wasm)"
  else
    error "未找到 emcc（Emscripten），且缺失缓存产物。请安装 Emscripten 3.1.64 后运行: ./scripts/build-fastzxing.sh"
    exit 1
  fi

  # npm run build 已内嵌 prebuild（prepare-wasm.cjs）：校验 web 的
  # wasm-pkg，再拷 wasm-zstd.wasm 与 FAST ZXing 到 public/。
  # airferry_zxing.js/.wasm 缺失时脚本非零退出（FAST-only 硬要求），
  # npm run build 失败，set -e 中断。
  cd "$ROOT/apps/web"
  # ① 发送端：vite.config.ts 单入口 index.html → dist/
  npm run build 2>&1 | grep -E 'built in|error|✖' | while read -r line; do info "$line"; done
  info "发送端网页构建完成 → apps/web/dist/（index.html）"
  # ② 接收端：vite.receiver.config.ts 单入口 receiver.html → dist-receiver/
  npm run build:receiver 2>&1 | grep -E 'built in|error|✖' | while read -r line; do info "$line"; done
  info "接收端网页构建完成 → apps/web/dist-receiver/（receiver.html）"
  # ③ 发送端单文件版：vite.standalone.config.ts + build-standalone.cjs → dist-standalone/index.html
  #    产物按版本规范命名并复制到 dist/（airferry-sender-web-standalone-v<VER>.html），
  #    双击即可在 file:// 下运行（发送端，不含接收端）。
  npm run build:standalone 2>&1 | grep -E 'Standalone|error|✖' | while read -r line; do info "$line"; done
  if [[ -f "$ROOT/apps/web/dist-standalone/index.html" ]]; then
    mkdir -p "$ROOT/dist"
    cp "$ROOT/apps/web/dist-standalone/index.html" \
       "$ROOT/dist/airferry-sender-web-standalone-v${VER}.html"
    info "发送端单文件版 → dist/airferry-sender-web-standalone-v${VER}.html（双击即用）"
  else
    warn "单文件版构建产物缺失：apps/web/dist-standalone/index.html，跳过复制到 dist/"
  fi
}

# 打包 Chrome MV2/MV3 为已签名 .crx。
#
# Chrome 发布必须复用固定私钥，并核对其公钥指纹。缺失或换钥直接失败，
# 防止无意生成新的扩展 ID、让已安装用户无法原位升级。
pack_chrome_crx() {
  local prod_dir="$1"   # 如 chrome-mv3-prod
  local plat="${prod_dir%-prod}"   # chrome-mv3
  local key="$ROOT/dist/airferry-extension.pem"

  if ! detect_chrome_bin; then
    # 与 verify-dist.mjs 对齐：签名私钥存在本身就是签名意图，dist 模式也
    # 必须 fail-closed（否则 build 过了、verify 门禁才失败，两个门禁打架）。
    if [[ "$REQUIRE_SIGNED_ARTIFACTS" == "1" || -f "$key" ]]; then
      error "未找到可用于打包 CRX 的 Chrome；签名私钥存在（$key），必须产出已签名 ${plat}.crx。可通过 CHROME_BIN 指定。"
    fi
    warn "未找到 Chrome，跳过 ${plat} 的 .crx 签名，仅保留 .zip（release 模式会失败）"
    return 0
  fi

  if [[ ! -f "$key" ]]; then
    if [[ "$REQUIRE_SIGNED_ARTIFACTS" == "1" ]]; then
      error "缺少固定 Chrome 签名私钥: $key（release 必须复用固定扩展 ID）"
    fi
    warn "缺少固定 Chrome 签名私钥，跳过 ${plat}.crx，仅保留 .zip（release 模式会失败）"
    return 0
  fi
  command -v openssl >/dev/null 2>&1 || error "找不到 openssl，无法核对 Chrome 公钥指纹"
  local actual_key_sha
  actual_key_sha="$(openssl rsa -in "$key" -pubout -outform DER 2>/dev/null | shasum -a 256 | awk '{print $1}')"
  [[ "$actual_key_sha" == "$EXPECTED_CHROME_PUBLIC_KEY_SHA256" ]] || \
    error "Chrome 签名密钥不是 AirFerry 固定发布密钥（实际公钥 SHA-256: $actual_key_sha）"
  "$CHROME_BIN" --pack-extension="$ROOT/apps/web/build/$prod_dir" \
                --pack-extension-key="$key" >/dev/null 2>&1 || {
    if [[ "$REQUIRE_SIGNED_ARTIFACTS" == "1" ]]; then
      error "${plat} 的 .crx 打包失败；release 拒绝继续"
    fi
    warn "${plat} 的 .crx 打包失败，仅保留 .zip（release 模式会失败）"
    return 0
  }

  # Chrome 把 .crx 产物写到 build/<prod_dir>.crx，搬到 dist 并按规范命名。
  mv "$ROOT/apps/web/build/${prod_dir}.crx" \
     "$ROOT/dist/airferry-sender-${plat}-v${VER}.crx"
  info "发送端 ${plat} → dist/airferry-sender-${plat}-v${VER}.crx"
}

# 仅打包：假设 apps/web/build/ 与 APK 已构建好，把它们复制/签名到 dist/。
pack_dist() {
  info "打包产物到 dist/（版本 v${VER}）..."
  mkdir -p "$ROOT/dist"
  # 清掉旧产物，避免新旧版本/命名混留（pem / keystore 不动）。
  rm -f "$ROOT/dist"/airferry-receiver-android-*.apk \
        "$ROOT/dist"/airferry-android-*.apk \
        "$ROOT/dist"/airferry-receiver-windows-*.zip \
        "$ROOT/dist"/airferry-windows-*.zip \
        "$ROOT/dist"/airferry-sender-*.crx \
        "$ROOT/dist"/airferry-sender-*.zip \
        "$ROOT/dist"/airferry-sender-*.xpi \
        "$ROOT/dist"/airferry-chrome-*.crx \
        "$ROOT/dist"/airferry-chrome-*.zip \
        "$ROOT/dist"/airferry-firefox-*.xpi \
        "$ROOT/dist"/airferry-sender-web-*.zip \
        "$ROOT/dist"/airferry-sender-web-standalone-*.html \
        "$ROOT/dist"/airferry-receiver-web-*.zip \
        "$ROOT/dist"/airferry-web-*.zip

  # 扫码端 APK（仅当已构建时打包）
  local apk_src="$ROOT/apps/scanner/app/build/outputs/apk/release/app-release.apk"
  if [[ -f "$apk_src" ]]; then
    verify_apk_signature "$apk_src"
    cp "$apk_src" "$ROOT/dist/airferry-receiver-android-arm64-v${VER}.apk"
    info "Android 接收端 → dist/airferry-receiver-android-arm64-v${VER}.apk"
  else
    warn "未找到 Android APK（${apk_src}）。如需打包，先运行: ./scripts/build-all.sh scanner"
  fi

  # Windows 端 zip（仅当已构建时打包——Windows 端须在 Windows 上构建）
  local win_publish="$ROOT/apps/windows/AirFerry.Windows/bin/x64/Release/net8.0-windows/win-x64/publish"
  if [[ ! -d "$win_publish" ]]; then
    win_publish="$ROOT/apps/windows/AirFerry.Windows/bin/x64/Release/net8.0-windows/publish"
  fi
  if [[ -d "$win_publish" ]]; then
    ( cd "$win_publish" && zip -r -q -X "$ROOT/dist/airferry-receiver-windows-x64-v${VER}.zip" . )
    info "Windows 接收端 → dist/airferry-receiver-windows-x64-v${VER}.zip"
  else
    warn "未找到 Windows 端 publish 产物。如需打包 Windows 端，请在 Windows 上运行: ./scripts/build-windows.ps1 -Pack"
  fi

  # 网页端 zip（纯静态站点，解压即可托管到任意静态服务器）。发送端与接收端
  # 拆成两个独立 zip，各自自包含可独立部署：
  #   • airferry-sender-web-v{VER}.zip    ← dist/        （index.html 发送端）
  #   • airferry-receiver-web-v{VER}.zip  ← dist-receiver/（receiver.html 接收端）
  # 发送端 zip 排除接收端 QR 解码专用资产：airferry_zxing.js/.wasm（FAST
  # ZXing-C++ 后端，接收端唯一解码后端）——它们只被接收端 receiver.html 的
  # qr-decode worker 使用，发送端 zip 不应带入。接收端自带 wasm-zstd.wasm
  # （解压 zstd 载荷）+ airferry_zxing.*。与 Windows 同样用 warn 而非 error：
  # 用户可能只想发扩展+APK 而不发网页端。
  local web_dist="$ROOT/apps/web/dist"
  if [[ -d "$web_dist" ]]; then
    ( cd "$web_dist" && zip -r -q -X "$ROOT/dist/airferry-sender-web-v${VER}.zip" . -x 'airferry_zxing.js' -x 'airferry_zxing.wasm' )
    info "发送端网页 → dist/airferry-sender-web-v${VER}.zip（index.html）"
  else
    warn "未找到发送端网页构建产物（${web_dist}）。如需打包，先运行: ./scripts/build-all.sh web"
  fi
  local web_receiver_dist="$ROOT/apps/web/dist-receiver"
  if [[ -d "$web_receiver_dist" ]]; then
    ( cd "$web_receiver_dist" && zip -r -q -X "$ROOT/dist/airferry-receiver-web-v${VER}.zip" . )
    info "接收端网页 → dist/airferry-receiver-web-v${VER}.zip（receiver.html）"
  else
    warn "未找到接收端网页构建产物（${web_receiver_dist}）。如需打包，先运行: ./scripts/build-all.sh web"
  fi

  # 发送端单文件版（自包含 HTML，双击 file:// 即用）。build_web 构建时已复制一份
  # 到 dist/，但上方清旧产物把它删掉了——此处按 warn 模式重建（与 web zip 同理：
  # 用户可能只发扩展+APK 不发网页端，缺失不中断）。否则单独跑 `dist` 子命令会
  # 让单文件版从 dist/ 静默消失，dist-upload-list / Release 随之缺一个产物。
  local standalone_html="$ROOT/apps/web/dist-standalone/index.html"
  if [[ -f "$standalone_html" ]]; then
    cp "$standalone_html" "$ROOT/dist/airferry-sender-web-standalone-v${VER}.html"
    info "发送端单文件版 → dist/airferry-sender-web-standalone-v${VER}.html（双击即用）"
  else
    warn "未找到单文件版构建产物（${standalone_html}）。如需打包，先运行: ./scripts/build-all.sh web"
  fi

  # 发送端：Chrome crx + zip，Firefox xpi（即 zip 改名）
  for target in chrome-mv3-prod chrome-mv2-prod firefox-mv3-prod firefox-mv2-prod; do
    local prod_dir="$target"
    local plat="${prod_dir%-prod}"
    local src_dir="$ROOT/apps/web/build/$prod_dir"
    [[ -d "$src_dir" ]] || error "找不到发送端构建：${src_dir}（先运行 build-all.sh sender）"

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

  # 打印可安全上传到 GitHub Release 的产物清单（见 release_upload_list 的安全说明）。
  info "可上传到 GitHub Release 的产物清单（已排除 *.pem / *.keystore 密钥）:"
  release_upload_list | sed 's/^/    /'
}

# 列出 dist/ 中可安全上传到 GitHub Release 的当前版本产物。
#
# ⚠️ 安全要点（改动前务必理解）：dist/ 与产物同目录还存放两类签名密钥——
#   • airferry-extension.pem     Chrome Cr24 签名私钥
#   • airferry-release.keystore  Android 发布 keystore
# 裸 `gh release upload ... dist/*` 的 shell 通配会把它们一并上传 → 密钥外泄。
# 本函数用「当前版本号 airferry-*-v${VER}.* ＋ 扩展名白名单」双重过滤，物理上
# 不可能命中 *.pem / *.keystore，也不会误带其它版本旧产物或 RELEASE_NOTES_*.md。
# 上传命令（用命令替换取清单，勿用裸 dist/* 通配）：
#   gh release upload v${VER} -R UR-SillyB/AirFerry \
#     $(./scripts/build-all.sh dist-upload-list) --clobber
release_upload_list() {
  # dist/ 可能尚未创建（干净机器上未跑过任何构建）：打印空清单而非让 find
  # 报错触发 set -e——调用方的命令替换拿到空串即可，语义一致。
  [[ -d "$ROOT/dist" ]] || return 0
  find "$ROOT/dist" -maxdepth 1 -type f \
    -name "airferry-*-v${VER}.*" \
    \( -name '*.apk' -o -name '*.zip' -o -name '*.crx' -o -name '*.xpi' -o -name '*.html' \) \
    | sort
}

build_release() {
  info "构建全部 + 打包到 dist/ ..."
  build_sender
  build_web
  build_scanner
  pack_dist
}

case "$TARGET" in
  all)
    build_sender
    build_web
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
  web)
    build_web
    ;;
  wasm)
    build_wasm
    ;;
  dist)
    pack_dist
    ;;
  dist-upload-list)
    # 仅打印可安全上传的产物清单（不含密钥），供 gh release upload 命令替换使用。
    release_upload_list
    exit 0
    ;;
  release)
    build_release
    ;;
  *)
    echo "用法: $0 [all|sender|scanner|windows|web|wasm|dist|dist-upload-list|release]"
    echo "  windows 子命令须在 Windows + .NET 8 SDK + CMake/VS C++ 下运行（或用 scripts/build-windows.ps1）"
    echo "  dist-upload-list 打印可安全上传到 GitHub Release 的产物清单（排除 *.pem/*.keystore 密钥）"
    exit 1
    ;;
esac

info "构建完成!"
