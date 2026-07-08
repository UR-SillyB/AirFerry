# AGENTS.md — AI 代理操作手册

> 本文是给 AI 代理（以及人类开发者）的**导航 + 操作索引**：怎么构建、怎么定位代码、怎么排错、哪些坑别踩。
> 本文**不重复** `docs/*.md` 的细节，每条都指向权威来源。跨端不变量的位级规格见 [`docs/SPEC.md`](docs/SPEC.md)。
> **遇到文档与代码冲突时，一律以代码为准**（见下方「文档与代码偏差清单」）。
> **当本文与 `docs/SPEC.md` 互相矛盾时**（如默认值、常量、行号），先去读对应权威源代码裁决——两份文档都可能滞后，切勿仅凭其中一份下结论。
> **每次改动代码后，必须同步更新相关文档**：改动若涉及常量、默认值、行号、签名、帧格式、文件路径、构建步骤等任一被文档引用的事实，**同一提交内**回写 AGENTS.md / docs/*.md 的对应位置，勿留滞后（本次审计即是文档滞后于代码的教训）。

## 项目一句话

**AirFerry**：完全离线的光学文件传输。发送端（浏览器扩展）把文件编成二维码视频流在屏幕上连续播放；接收端（Android App）用摄像头实时扫描恢复文件。两端共享同一套 Rust 核心库（分别编译为 WASM 与 Android Native `.so`），编解码逻辑数学上一致。**零网络依赖、单向信道、无握手**。

---

## 1. 仓库布局

```
AirFerry/
├── core/                       # Rust 核心库（三 crate workspace）
│   ├── raptorq-core/           #   RFC 6330 RaptorQ 编解码封装（纯逻辑）
│   ├── qr-protocol/            #   帧格式 / 分块 / 压缩 / CRC / QR 矩阵 / 会话 ID
│   └── transfer-engine/        #   编排 / 状态机 / 进度 / 断点 + WASM&JNI 绑定
├── apps/
│   ├── sender/                 # 浏览器扩展（Plasmo + React + TS + WASM）
│   │   ├── src/                #   TS 源码（页面 / WASM 桥 / 压缩 worker / background 图标点击直跳）
│   │   ├── wasm-pkg/           #   wasm-pack 产物（generated, git-ignored）
│   │   ├── assets/             #   扩展图标
│   │   └── scripts/            #   构建 / manifest 修正 / lzma-wasm 提取
│   ├── web/                    # 网页端（Vite + React + TS）— 直接复用 sender/src 源码，无代码重复
│   │   ├── src/main.tsx        #   薄入口：mount sender 的 App（options.tsx）
│   │   ├── scripts/            #   prepare-wasm（校验 sender wasm-pkg + 拷 wasm-zstd）/ lzma 提取
│   │   └── public/             #   wasm-zstd.wasm（worker 运行时 fetch，构建时拷入）
│   ├── scanner/                # Android App（Kotlin + CameraX + ZXing-C++）
│   │   └── app/src/main/
│   │       ├── java/com/airferry/app/   # Kotlin
│   │       ├── cpp/                     # ZXing-C++ JNI 桥（CMake）
│   │       └── jniLibs/arm64-v8a/       # Rust .so（cargo-ndk 产物, git-ignored）
│   └── windows/                # Windows App（C# WPF + OpenCvSharp + ZXing.Net）
│       ├── AirFerry.Windows/            #   主项目（Views/ViewModels/Scan/Bundle/Native）
│       │   └── runtime/transfer_engine.dll  # Rust C ABI 产物（build-windows.ps1 拷入, git-ignored）
│       └── AirFerry.Windows.Tests/      #   协议层单元测试（net8.0，跨平台可跑）
├── docs/                       # 协议 / 架构 / API / 构建说明（中文）
├── scripts/build-all.sh        # 一键构建脚本（含 windows 子命令）
├── scripts/build-windows.ps1   # Windows 端原生 PowerShell 构建脚本（首选）
├── Cargo.toml                  # Rust workspace 根配置
└── dist/                       # 发布产物 + 签名密钥（git-ignored）
```

---

## 2. 快速构建命令

### 2.1 核心库（Rust）

```bash
# 全部单元 + 集成测试（根目录）
cargo test

# 含 diag_* 基准测试（默认 #[ignore]）
cargo test -- --ignored

# 仅构建
cargo build            # 或 cargo build --release
```

> 集成测试位于 `core/transfer-engine/tests/`：`e2e.rs`（端到端恢复 + 丢帧/乱序/重复）、`compress_pipeline.rs`（压缩往返）、`wasm_interop.rs`（跨语言，需先跑 `wasm_dump_frames.mjs` 生成 `frames.bin`/`payload.bin`）、`filemeta_check.rs`（元数据往返）；`diag_*.rs` 为性能/复现基准。

### 2.2 浏览器发送端（apps/sender）

```bash
cd apps/sender
npm install            # 首次（含 postinstall: 提取 lzma-wasm）

# ① 先构建 WASM 双产物（必须是扩展构建的前置）
npm run wasm
#   等价: node scripts/build-wasm.cjs，构建两份 wasm：
#     • wasm-pkg-legacy/ — wasm-bindgen =0.2.92（默认锁定）、标量、无 SIMD、无 externref
#       → Chrome 87+/FF 91+ 可加载，供 MV2 目标使用
#     • wasm-pkg-simd/   — wasm-bindgen =0.2.125（脚本临时升级）、+simd128、含 externref
#       → Chrome 91+/FF 89+ 支持 SIMD、Chrome 96+/FF 116+ 支持 externref，供 MV3 目标使用
#   ⚠️ Cargo.toml 还原：build-wasm.cjs 在构建 MV3 时临时把 wasm-bindgen 改成 =0.2.125
#       （js-sys/web-sys 同期 0.3.102），构建完在 finally 里：
#         ① 内存还原 Cargo.toml（从脚本启动时读的 originalToml 字节级回写）
#         ② `git checkout Cargo.lock` 还原 Cargo.lock（不能用 cargo generate-lockfile，
#            那会把无关包也升到最新，污染 lockfile）
#       跑完 `npm run wasm` 后 `git status` 对 Cargo.toml/Cargo.lock 必须无改动。
#   说明: `wasm` feature 已隐含 `serde`（见 core/transfer-engine/Cargo.toml）。
#         SIMD（+simd128）是 RUSTFLAGS target-feature，与 wasm-bindgen 版本正交——
#         0.2.92 也能开 SIMD。MV3 同时开新版 wasm-bindgen（externref）+ SIMD。
#   ⚠️ 实测结论（见 §5.7）：当前 raptorq/qrcode crate 均为纯标量 Rust，无 SIMD
#       intrinsics，+simd128 对热路径无收益（0.95×，wasm 反而大 ~8KB）。新版
#       wasm-bindgen 的 externref 对 JS↔WASM 交互也无显著提升。双产物机制的
#       真实价值是「MV2 兼容老 Chrome + MV3 用新工具链」各得其所，并为未来
#       引入 SIMD 化的库（如换更快 QR 库、RaptorQ 用 GF(256) SIMD）铺路。

# ② 构建扩展（全部 4 个目标，会自动先跑 extract-lzma-wasm + build-wasm.cjs）
npm run build
#   等价: extract-lzma-wasm.cjs && build-wasm.cjs（双 wasm 产物） && build-all.cjs
#   build-all.cjs 按 MV2/MV3 把对应 wasm-pkg-* 目录复制到 wasm-pkg/ 后再 plasmo build：
#     chrome-mv3 / firefox-mv3 → wasm-pkg-simd/   复制为 wasm-pkg/
#     chrome-mv2 / firefox-mv2 → wasm-pkg-legacy/ 复制为 wasm-pkg/
#   loader.ts 的 import 路径固定为 `../../wasm-pkg/`，靠 swap 目录名切换。
#   产物: apps/sender/build/{chrome,firefox}-{mv2,mv3}-prod/

# 单独构建某个目标（不自动跑 wasm 双产物，需先 `npm run wasm`）
npm run build:chrome-mv3     # 或 :chrome-mv2 / :firefox-mv3 / :firefox-mv2

npm run dev                  # Plasmo HMR 开发模式
```

| 目标目录 | 支持浏览器 |
|---------|-----------|
| `chrome-mv3-prod` | Chrome / Edge（MV3） |
| `chrome-mv2-prod` | Chrome / Edge（MV2 遗留） |
| `firefox-mv3-prod` | Firefox 109+ |
| `firefox-mv2-prod` | Firefox 91+ |

### 2.3 Android 扫码端（apps/scanner）

```bash
# ① 先构建 Rust JNI 库（cargo-ndk，必须是 APK 构建的前置）
cargo ndk -t arm64-v8a \
  -o apps/scanner/app/src/main/jniLibs \
  build -p transfer-engine --features jni --release
#   产物: apps/scanner/app/src/main/jniLibs/arm64-v8a/libtransfer_engine.so

# ② 构建 APK
cd apps/scanner
./gradlew :app:assembleDebug      # 调试 APK
./gradlew :app:assembleRelease    # 发布 APK（用 keystore.properties 签名，缺失则回退 debug 签名）
#   产物: app/build/outputs/apk/{debug,release}/app-*.apk

adb install app/build/outputs/apk/release/app-release.apk
```

> ZXing-C++（`libairferry_zxing.so`）由 Gradle 的 CMake 任务在首次 APK 构建时从 GitHub 拉取 v3.0.2 自动编译（需网络；缓存后离线可用）。
> **16 KiB 页对齐**：Android 15+ 的 16 KiB 页设备会拒绝 `dlopen` 仅 4 KiB 对齐的 `.so`（表现：所有 QR 解码静默失败）。`cpp/CMakeLists.txt` 用 `-Wl,-z,max-page-size=16384` 强制对齐；Rust `.so` 由 cargo-ndk 默认对齐。验证：`llvm-readelf -l lib*.so | grep LOAD`（Align 列应为 `0x4000`）。

### 2.4 Windows 扫码端（apps/windows）

```powershell
# 首选：PowerShell 原生脚本（须 Windows + .NET 8 SDK）
.\scripts\build-windows.ps1           # 构建（cargo DLL + dotnet build）
.\scripts\build-windows.ps1 -Pack     # 构建 + 打包到 dist/

# 或 Git Bash/WSL 下用 build-all.sh 的 windows 子命令（逻辑等价）
./scripts/build-all.sh windows
```

> **WPF 只能在 Windows 上构建**（`net8.0-windows` TFM 依赖 Windows SDK）。
> **协议层单元测试**（`AirFerry.Windows.Tests`）用纯 `net8.0`，可在任何 OS 上跑（只测 IngestStatus 位域/FrameHeader/BundleParser 等纯逻辑，不依赖 P/Invoke）：
> ```bash
> cd apps/windows && dotnet test    # 任意 OS
> ```
> 详见 [`docs/build-windows.md`](docs/build-windows.md)。

### 2.5 网页端（apps/web）

```bash
cd apps/web
npm install            # 首次（含 postinstall: 提取 lzma-wasm）

npm run dev            # Vite HMR 开发（http://localhost:5180）
npm run build          # 产出静态站点 dist/（可部署到任意静态托管）
npm run build:standalone  # 产出自包含单文件 dist-standalone/index.html（双击即用，file:// 可运行）
npm run preview        # 本地预览构建产物
```

> **复用 sender 源码，零代码重复**：web 端是薄入口（`src/main.tsx` 只 mount sender 的 `App`），通过 Vite alias `@/ → ../sender/src/` 直接跨工程 import `apps/sender/src/` 的全部页面/组件/worker/wasm 模块。改 sender 业务代码，web 端自动同步。
>
> **唯一前置依赖**：web 构建复用 `apps/sender/wasm-pkg/`（Rust WASM 产物）。首次构建前需在 sender 下先跑一次 `npm run wasm`（即 `build-wasm.cjs`）。`predev`/`prebuild` 会跑 `prepare-wasm.cjs` 校验存在性，缺失时报清晰错误。
>
> **环境自适应**：sender 的 `options.tsx` 用 `typeof chrome` 判断 —— 扩展走 `chrome.runtime.getURL`，网页走 `new URL(..., document.baseURI)`。`compress.ts` 的 worker 内 zstd 加载同样有网页 fallback。两端共用同一份 `options.tsx`，扩展行为不变。
>
> **部署**：`dist/` 是纯静态文件，资源用相对路径（`base: "./"`），可放 GitHub Pages / Netlify / 任意静态服务器的任意子路径。`wasm-zstd.wasm` 在产物根目录供 worker 运行时 fetch。核心传输**不需要** COOP/COEP 头（不依赖 SharedArrayBuffer）。详见 [`docs/build-web.md`](docs/build-web.md)。
>
> **单文件版（`npm run build:standalone`）**：产出**单个 `dist-standalone/index.html`**（约 2MB），所有 JS/CSS/Worker/WASM 内联（WASM 转 base64），**双击即可在 `file://` 下运行**，无需服务器。原理：① Vite IIFE bundle（去 ES module 标记，绕过 file:// 的 module 限制）；② worker 源码字符串化后用 Blob URL 加载（绕过 file:// 的 Worker 限制）；③ 三个 WASM base64 内联 + 复用现成 buffer 接口（`init(buffer)` / `initZstdFromBytes` / lzma 自带 base64，绕过 file:// 的 fetch 限制）。`build-standalone.cjs` 后处理脚本完成内联，并处理 `</script>` 转义、`import.meta.url` 替换、`process` polyfill 三个细节。sender 源码（`options.tsx`/`loader.ts`）通过 `globalThis.__AIRFERRY_STANDALONE__` 标志做环境自适应，扩展/web 普通版不受影响。

### 2.6 一键脚本 `scripts/build-all.sh`

| 子命令 | 动作 | 是否自动跑 cargo 前置 |
|--------|------|---------------------|
| `all`（默认） | `build_sender` + `build_web` + `build_scanner` | ✅（scanner） |
| `sender` | 双 wasm 产物 + 扩展 4 目标 | — |
| `web` | `npm run build`（apps/web，Vite 静态站点；自动跑 `prebuild`→prepare-wasm 校验 sender `wasm-pkg/` + 拷 `wasm-zstd.wasm`） | — |
| `scanner` | `cargo ndk` 编译 `.so` → `./gradlew assembleRelease` | ✅ |
| `windows` | `cargo build --features cffi` 编译 DLL → `dotnet build`（须 Windows） | ✅ |
| `wasm` | 仅 `npm run wasm`（= build-wasm.cjs，产 legacy + simd 两份） | — |
| `dist` | **仅打包**：把已构建的 `build/` + APK + Windows zip + web zip 复制/签名到 `dist/`（不重新构建） | — |
| `release` | `build_sender` → `build_web` → `build_scanner` → `pack_dist`（全量构建 + 打包） | ✅（scanner） |

```bash
./scripts/build-all.sh              # 构建 sender + web + scanner（不打包）
./scripts/build-all.sh release      # 全量构建 + 打包到 dist/（最常用）
./scripts/build-all.sh dist         # 仅打包（假设已构建好，不重新编译）
./scripts/build-all.sh sender       # 仅浏览器端（含 WASM）
./scripts/build-all.sh web          # 仅网页端（须先有 apps/sender/wasm-pkg/）
./scripts/build-all.sh scanner      # 仅 APK
./scripts/build-all.sh windows      # 仅 Windows 端（须 Windows + .NET 8 SDK；首选 build-windows.ps1）
./scripts/build-all.sh wasm         # 仅 WASM
```

**脚本行为要点**（权威源 `scripts/build-all.sh`）：
- **版本号**：从 `apps/sender/package.json` 的 `version` 读取（`read_version()`），与扩展 manifest 同源。改版本改这一处即可被脚本读取，但 APK/扩展本身的版本号仍需手动同步（见 §2.7）。
- **`build_scanner` 自动跑 cargo-ndk**：在 `./gradlew assembleRelease` **之前**先用 `cargo ndk -t arm64-v8a ... build -p transfer-engine --features jni --release` 编译 `libtransfer_engine.so` 到 `jniLibs/`。这是为了避免打进过期 `.so`（AirFerry 重命名后旧符号 `com.easytransfer.*` 与 Kotlin 新包名对不上会 `UnsatisfiedLinkError` 闪退）。因此 `scanner`/`all`/`release` 子命令都自带这步，无需手动前置。
- **`build_windows` 自动跑 cargo**：在 `dotnet build` **之前**先用 `cargo build -p transfer-engine --features cffi --release` 编译 `transfer_engine.dll` 到 `runtime/`（对标 scanner 的 cargo-ndk 前置，防止过期/缺失 DLL 致运行时 `DllNotFoundException`）。**Windows 端只能在 Windows + .NET 8 SDK 下构建**，首选 `scripts/build-windows.ps1`。
- **`build_web` 不编译 Rust**：`cd apps/web && npm run build`（Vite 静态站点），`prebuild` 会跑 `prepare-wasm.cjs` 校验 `apps/sender/wasm-pkg/transfer_engine.js` 存在 + 拷贝 `wasm-zstd.wasm` 到 `public/`。web 复用 sender 的 wasm-pkg，**首次构建前须先 `cd apps/sender && npm run wasm`**（缺失时 `prepare-wasm.cjs` 报清晰错误并中断，不会静默打进过期产物）。`pack_dist` 用 warn（非 error）模式打包 web zip——产物缺失时跳过而非中断，因为用户可能只发扩展+APK 不发网页端。
- **Chrome crx 签名**：调用 macOS Chrome 的 `--pack-extension` + `--pack-extension-key`。私钥固定在 `dist/airferry-extension.pem`——**首次运行自动生成并挪到此处，之后 MV2/MV3 复用同一私钥**，保证扩展 ID 稳定。找不到 Chrome 二进制时跳过 crx、仅留 zip。
- **`pack_dist` 会清旧产物**：删 `dist/airferry-{android-*.apk,windows-*.zip,sender-*.crx,sender-*.zip,sender-*.xpi,web-*.zip}`，但**不动** `*.pem` 和 `*.keystore`。

### 2.7 构建目录布局

三层产物目录，**全部 git-ignored**（见 `.gitignore`）：

```
源码 ──构建──► 中间产物目录 ──打包──► dist/（发布）
```

| 目录 | 内容 | 来源 | git-ignored |
|------|------|------|-------------|
| `apps/sender/wasm-pkg-legacy/` | WASM 编译产物（wasm-bindgen 0.2.92 / 标量 / 无 externref，Chrome87-safe）；供 MV2 目标使用。内含 `.gitignore` 为 `*`（全忽略） | `npm run wasm:legacy`（由 build-wasm.cjs 调度） | ✅ |
| `apps/sender/wasm-pkg-simd/` | WASM 编译产物（wasm-bindgen 0.2.125 / +simd128 / 含 externref）；供 MV3 目标使用。内含 `.gitignore` 为 `*`（全忽略） | `npm run wasm:simd`（由 build-wasm.cjs 调度） | ✅ |
| `apps/sender/wasm-pkg/` | **临时**目录：build-all.cjs 在每次 plasmo build 前按目标把 `wasm-pkg-legacy/` 或 `wasm-pkg-simd/` 复制到这里（loader.ts 的 import 路径固定指向它）。不长期存在 | `build-all.cjs` 的 `useWasmPkg()` | ✅ |
| `apps/sender/build/` | Plasmo 扩展构建产物：`{chrome,firefox}-{mv2,mv3}-prod/` 四个目录 + 构建期生成的 `.crx`/`.xpi`/`.zip` | `npm run build` | ✅ |
| `apps/web/public/wasm-zstd.wasm` | zstd WASM，构建时由 `prepare-wasm.cjs` 从 `@foxglove/wasm-zstd/dist/` 拷入，供 worker 运行时 fetch | `predev`/`prebuild`（prepare-wasm.cjs） | ✅ |
| `apps/web/dist/` | Vite 网页构建产物：`index.html` + `assets/`（JS/CSS/wasm/worker）+ 根目录 `wasm-zstd.wasm`。相对路径 `base:"./"`，可部署到任意子路径 | `npm run build` | ✅ |
| `apps/scanner/app/build/` | Gradle/APK 构建产物：`outputs/apk/{debug,release}/app-*.apk` + native-debug-symbols + baselineProfiles | `./gradlew` | ✅ |
| `apps/scanner/app/src/main/jniLibs/arm64-v8a/` | Rust 编译的 `libtransfer_engine.so` + 遗留的 `libet_code.so`（**当前代码无任何 `System.loadLibrary("et_code")` 引用，未使用，建议清理**）。ZXing 的 `libairferry_zxing.so` 不在此处——由 CMake 在 APK 构建时直接编译进 APK | `cargo ndk ... build` | ✅ |
| `apps/windows/AirFerry.Windows/bin/` `obj/` | C# WPF 构建产物：`bin/x64/Release/net8.0-windows/AirFerry.exe` + OpenCV native DLLs | `dotnet build` / `dotnet publish` | ✅ |
| `apps/windows/AirFerry.Windows/runtime/transfer_engine.dll` | Rust 编译的 C ABI DLL（`--features cffi`），csproj 标 `CopyToOutputDirectory=PreserveNewest` 打进 exe 同目录 | `cargo build`（由 build-windows.ps1 拷入） | ✅ |
| `dist/` | 发布归档 + 签名材料（`*.pem` Chrome 私钥、`airferry-release.keystore`） | `pack_dist` | ✅ |
| `target/` | Rust 编译缓存（workspace 共享） | `cargo` | ✅ |

> 构建产物**绝不提交 git**。分发走 GitHub Release，产物放 `dist/`。

### 2.8 产物格式与命名规范

发布归档（`dist/`）的命名格式 = `airferry-{端}-{平台}-v{版本}.{扩展}`：

| 产物 | 命名格式 | 格式说明 |
|------|---------|---------|
| Android APK | `airferry-android-v{VER}.apk` | arm64-v8a 单 ABI；Android 10+（minSdk 29）；用 `apps/scanner/keystore.properties` 指向的 keystore 签名（缺失则回退 debug 签名） |
| Windows zip | `airferry-windows-x64-v{VER}.zip` | x64 单架构；Windows 10+；`dotnet publish` 单文件 + 框架依赖（目标机须装 .NET 8 运行时）；内含 `AirFerry.exe` + `transfer_engine.dll` + OpenCV native DLLs。**只能在 Windows 上构建**（WPF TFM） |
| Chrome MV3 | `airferry-sender-chrome-mv3-v{VER}.crx` + `.zip` | `.crx` = Cr24 签名格式（Chrome 88+/Edge 88+，可拖拽安装）；`.zip` = 解压目录打包（商店外安装被拦截时的回退） |
| Chrome MV2 | `airferry-sender-chrome-mv2-v{VER}.crx` + `.zip` | 同上，旧版兼容 |
| Firefox MV3 | `airferry-sender-firefox-mv3-v{VER}.xpi` | Firefox 109+；`.xpi` 本质是 zip 改名 |
| Firefox MV2 | `airferry-sender-firefox-mv2-v{VER}.xpi` | Firefox 91+ |
| 网页端 | `airferry-web-v{VER}.zip` | 纯静态站点（`index.html` + `assets/` + 根目录 `wasm-zstd.wasm`）；Vite `base:"./"` 相对路径，可部署到任意静态托管的任意子路径。`pack_dist` 自动打包（须先跑 `build-all.sh web` 产出 `apps/web/dist/`，缺失时 warn 跳过） |
| 网页端单文件 | `airferry-web-standalone-v{VER}.html` | **单个自包含 HTML**（约 2MB），所有 JS/CSS/Worker/WASM 内联（WASM 转 base64），**双击在 `file://` 下即用**，无需服务器。由 `cd apps/web && npm run build:standalone` 产出（`dist-standalone/index.html` → 改名）。不进 `pack_dist`（与 `airferry-web-*.zip` 不同，单文件是 `.html` 无需 zip），手动上传 Release |

**扩展产物内部结构**（每个 `*-prod/` 目录）：
- `manifest.json`——由 `scripts/fix-manifest.cjs` 后处理：复制真实 RGBA 图标覆盖 Plasmo 占位图、MV2 删 `action` 留 `browser_action` 并把 CSP 改为 `wasm-eval`、Firefox 补 `browser_specific_settings.gecko.id = airferry@airferry.app`、修补 HTML `<title>`
- `transfer_engine_bg.wasm` + `wasm-zstd.wasm` + `lzma-wasm.wasm`——运行时加载的 WASM 模块
- 图标 `icon{16,32,48,64,128}.png`

> MV2 与 MV3 用同一 Chrome 签名私钥打包会得到**相同的扩展 ID**（`nboajkjpabbekenmadidokmefholfmfk`），便于升级替换。

### ⚠️ 关键依赖顺序（最容易踩的坑）

1. **WASM 双产物必须先于扩展构建**：`npm run build` 已内嵌 `build-wasm.cjs`（产 `wasm-pkg-legacy/` + `wasm-pkg-simd/`）再 `build-all.cjs`，故一条命令搞定。但**单独跑 `npm run build:chrome-mv3` 等单目标脚本不自动跑 wasm**——需先 `npm run wasm` 产出双产物，否则 `build-all.cjs` 的 `useWasmPkg()` 会因 `wasm-pkg-*/` 缺失报错退出。（`build-all.sh sender/release` 走 `npm run build`，不会踩坑。）
2. **JNI `.so` 必须先于 APK 构建**：`cargo ndk ... build` 产出 `libtransfer_engine.so` 到 `jniLibs/` 后，`./gradlew` 才能打包进 APK。**`build-all.sh` 的 `scanner`/`all`/`release` 子命令会自动先跑 cargo-ndk**（见 §2.5），所以走脚本不会踩坑；但**若单独手动跑 `./gradlew`**（不经脚本），必须自己先跑 cargo-ndk，否则 APK 会带过期/缺失的 `.so`、扫码端运行时 `UnsatisfiedLinkError` 闪退。
3. **C ABI DLL 必须先于 C# 构建**：`cargo build --features cffi` 产出 `transfer_engine.dll` 到 `runtime/` 后，`dotnet build` 才能打包进 exe 同目录。**`build-windows.ps1`/`build-all.sh windows` 会自动先跑 cargo**（见 §2.5），但**若单独手动跑 `dotnet build`**，必须自己先跑 cargo，否则运行时第一个 P/Invoke 调用 `DllNotFoundException`。
4. **`dist` 子命令不重新构建**：它假设 `apps/sender/build/` 与 APK 已就绪（Windows zip 可选），只做复制/签名/打包。缺 sender/scanner 产物会 `error` 退出；缺 Windows 产物则 `warn` 跳过（因为 Windows 端只能在 Windows 上构建）。
5. **版本号四处同步**：`build-all.sh` 的发布文件名版本取自 `apps/sender/package.json`，但 APK 自身的 `versionName`（`build.gradle.kts`）、Rust crate 版本（`Cargo.toml`）、Windows exe 版本（`AirFerry.Windows.csproj` `<Version>`）需手动保持一致。改版本时四处一起改：`package.json`（→ 文件名）+ `build.gradle.kts`（→ APK 内嵌）+ `Cargo.toml`（→ 核心库）+ `AirFerry.Windows.csproj`（→ exe 内嵌）。

---

## 3. 代码导航地图（file:line 索引）

### 3.1 核心库热路径

| 关注点 | 位置 | 说明 |
|--------|------|------|
| 编码器（源符号 O(1) + 按需修复） | `core/raptorq-core/src/encoder.rs:63,73` | `source_symbol` / `repair_symbols` |
| 解码器（任意顺序符号 + 块满即解） | `core/raptorq-core/src/decoder.rs:64` | `add_symbol`，含 ESI/载荷越界守卫(line 78) |
| **安全闸门** OTI 校验 | `core/raptorq-core/src/meta.rs:97` | `ObjectMeta::validate`——接收前必跑，防 panic-on-abort |
| **帧解析热点** | `core/qr-protocol/src/frame.rs:122` | `Frame::from_bytes`：magic/version/双层 CRC 校验 |
| 帧封装 | `core/qr-protocol/src/frame.rs:71,109` | `build` / `to_bytes` |
| 会话 ID 派生（FNV-1a 128） | `core/qr-protocol/src/session.rs:23` | `derive`——必须与 TS 端位一致 |
| 压缩分发 + 解压炸弹防护 | `core/qr-protocol/src/compress.rs:68,97` | `compress_with` / `decompress_with_limit` |
| QR 矩阵（动态最小版本） | `core/qr-protocol/src/qr_render.rs:74` | `encode`：576B帧→V16，1088B帧→V23 |
| **发送端帧流入口** | `core/transfer-engine/src/sender.rs:164` | `next_frame`：每16帧插描述符，首帧即描述符 |
| 无限新鲜修复符号 | `core/transfer-engine/src/sender.rs:235` | `next_symbol_id`：源一遍→无限新修复 |
| **接收端摄入入口** | `core/transfer-engine/src/receiver.rs:147` | `ingest`：缓存引导→描述符确认 OTI→喂解码器 |
| 描述符载荷解析 | `core/transfer-engine/src/descriptor.rs:178` | `parse_payload`：v1/v2/v3 + v2/v3 消歧 |
| 进度快照 | `core/transfer-engine/src/progress.rs` | `Progress` / `Stats` |
| 断点状态序列化 | `core/transfer-engine/src/resume.rs` + `receiver.rs` | `ResumeState`（serde-gated JSON）；`ReceiverSession::save_state` / `restore` |
| **JNI 绑定（Android）** | `core/transfer-engine/src/jni.rs:68` | `receiverIngest` 返回**packed jlong**（非 JSON，见 SPEC）；`receiverLastAssembleError` 暴露组装/解压失败原因 |
| **C ABI 绑定（Windows/.NET P/Invoke）** | `core/transfer-engine/src/cffi.rs:78` | `airferry_receiver_ingest` 返回**packed u64**（位布局与 jni.rs 完全一致）；assemble 用「Rust 分配+free」单次调用 |
| **WASM 绑定（浏览器）** | `core/transfer-engine/src/wasm.rs:86` | `next_qr`：帧+QR 编码一次调用；`next_qr_multi`（wasm.rs:113）多码版；`next_qr_into`（wasm.rs:158）零拷贝变体（热路径用）；`next_qr_multi_into`（wasm.rs:193）多码零拷贝 |

### 3.2 浏览器发送端

| 关注点 | 位置 | 说明 |
|--------|------|------|
| 主应用（4 页路由） | `apps/sender/src/options.tsx:92` | select→params→play→stats |
| **图标点击直跳（MV2/MV3 兼容）** | `apps/sender/src/background/index.ts` | `chrome.action.onClicked`/`browserAction.onClicked` → 新标签页打开 options。**无 `default_popup`**（popup.tsx 已删），listener 才会触发；有 popup 时 onClicked 永不触发 |
| popup（仅启动器） | ~~`apps/sender/src/popup.tsx`~~ | **已删除**——图标点击改为直接跳转，不再弹小窗 |
| **QR 渲染循环** | `apps/sender/src/components/QrStream.tsx:37` | Canvas2D rAF 驱动 `next_qr`/`next_qr_multi` |
| 单次 putImageData 绘制 | `apps/sender/src/components/QrStream.tsx:239` | `drawMatrix`：避免逐模块 fillRect |
| **文字传输魔数（ETTEXTv1）** | `apps/sender/src/wasm/text.ts` | `buildTextPayload`（文字→[magic][UTF-8]）/ `isTextPayload`；与 `bundle.ts` 的 ETBUNDL1 并列，**descriptor 不变** |
| **三算法选优压缩** | `apps/sender/src/wasm/compress.ts:277` | `preparePayload`：raw/zstd/xz，早期退出阈值 **70%** |
| 压缩 worker（离主线程） | `apps/sender/src/workers/compress.worker.ts` | 读→压缩→CRC32→会话 ID。文件走 `processFiles`，文字走 `processText`，共用 `finalizeAndPost` |
| WASM 加载器 | `apps/sender/src/wasm/loader.ts:14` | `ensureWasm` 一次性初始化 |
| 会话 ID（TS 端，镜像 Rust） | `apps/sender/src/wasm/session.ts:17` | `deriveSessionId` |
| 多文件容器 | `apps/sender/src/wasm/bundle.ts` | 打包格式（ETBUNDL1） |
| 4 个页面 | `apps/sender/src/pages/*.tsx` | FileSelect / Params / Play / Stats。FileSelect 顶部有「文件/文字」Tab 切换 |
| **文字草稿（IndexedDB）** | `apps/sender/src/storage/textDrafts.ts` + `FileSelectPage.tsx` TextTab | 命名保存（原文不 trim，与单条发送一致）；载入后可「更新草稿」；「一起发送」→ `draftsToFiles`（按保存时间正序 + `dedupeDraftFilenamesForBundle` 重名后缀）→ `processFiles`/ETBUNDL1。单条「发送当前这一条」仍走 `processText`/ETTEXTv1 |
| manifest 后处理 | `apps/sender/scripts/fix-manifest.cjs` | 图标/MV2 CSP/Firefox id；**兜底删 `default_popup`**（保证 onClicked 生效） |

### 3.3 Android 扫码端

| 关注点 | 位置 | 说明 |
|--------|------|------|
| Activity / 管线编排 | `app/.../ui/ScanActivity.kt:60` | owns 管线、相机绑定、摄入线程 |
| CameraX 生产者（非阻塞） | `app/.../scan/QrStreamAnalyzer.kt:16` | 拷贝 Y 平面入队后立即 close |
| **并行解码 + 串行摄入** | `app/.../scan/QrDecodePool.kt:27` | N worker(2-6) + `ingestLock` 串行化 |
| 多码 ROI 解码追踪 | `app/.../scan/QrDecodePool.kt:277` | `decodeMultiTracked` |
| **Rust JNI 桥（Kotlin）** | `app/.../nativelib/NativeBridge.kt` | `receiverIngest` 返回 Long |
| **接收会话管理器** | `app/.../scan/ReceiverSessionManager.kt:17` | 仅从描述符初始化；`IngestStatus.unpack`(line 67) |
| 帧头解析（Kotlin 侧） | `app/.../scan/ReceiverSessionManager.kt:98` | `parseHeader`：60B 大端 |
| ZXing JNI 桥（Kotlin） | `app/.../scan/ZxingDecoder.kt` | 单码/多码/ROI 解码 |
| **ZXing-C++ JNI（native）** | `app/src/main/cpp/scan_jni.cpp:52` | `decodeInView`：TryHarder+TryInvert |
| 多文件包解包 | `app/.../scan/BundleParser.kt` | 恢复后拆包（ETBUNDL1） |
| **文字载荷解析** | `app/.../scan/TextParser.kt` | `isText`/`parse`（ETTEXTv1 → UTF-8）；字节级镜像 TS `text.ts` 与 C# `TextParser.cs` |
| UI | `app/.../ui/{ReceiveDetail,ReceiveText,ReceiveBundle,FileList,Settings}Activity.kt` | 详情/文字/列表/设置。`ScanActivity.recoverAndStage` 按 text→bundle→单文件顺序分流 |
| **文字接收页（可复制/分享/存 .txt）** | `app/.../ui/ReceiveTextActivity.kt` | 文字接收后落盘为 `received/文字消息.txt` + `.meta`（第 5 行 `kind=text`）进历史记录；剪贴板 `ClipboardManager` + `ACTION_SEND` text/plain。FileListActivity 见 `kind=text` 跳本页（否则跳 ReceiveDetail） |

### 3.4 Windows 扫码端

| 关注点 | 位置 | 说明 |
|--------|------|------|
| **Rust C ABI 桥（P/Invoke）** | `apps/windows/AirFerry.Windows/Native/NativeBridge.cs` | 11 个 `[DllImport]` 声明，对标 Android `NativeBridge.kt`。⚠️ 每个**必须钉死 `EntryPoint = "airferry_*"`**：Rust `cffi.rs` 导出 snake_case 符号，而 P/Invoke 默认按 C# 方法名（PascalCase）查找——漏写会让首个 native 调用抛 `EntryPointNotFoundException`，且 CI 协议层单测（纯 C# 逻辑，不触达 DLL）无法发现。对比 JNI 由 JVM 自动解析 `Java_<class>_<method>` 名，Windows 走纯 C ABI 无此机制 |
| **接收会话管理器** | `apps/windows/AirFerry.Windows/Scan/ReceiverSession.cs` | lazy init from descriptor + mismatch re-init（镜像 Kotlin） |
| 帧头解析 | `apps/windows/AirFerry.Windows/Scan/FrameHeader.cs` | 60B 大端，magic/version/session_id hi+lo |
| IngestStatus 位域解析 | `apps/windows/AirFerry.Windows/Scan/IngestStatus.cs` | `.Unpack(u64)`，位布局与 Rust/Kotlin 一致 |
| **并行解码 + 串行摄入** | `apps/windows/AirFerry.Windows/Scan/QrDecodePool.cs` | N worker + `IngestLock` 串行化批摄入 |
| ★**设备枚举（摄像头+采集卡）** | `apps/windows/AirFerry.Windows/Scan/DeviceEnumerator.cs` | DirectShow `DsDevice`，两类设备统一枚举 |
| 视频采集 | `apps/windows/AirFerry.Windows/Scan/VideoCapture.cs` | OpenCvSharp VideoCapture（DirectShow 后端） |
| QR 解码 | `apps/windows/AirFerry.Windows/Scan/ZxingDecoder.cs` | ZXing.Net（TryHarder/TryInvert，对标 scan_jni.cpp） |
| 灰度→ZXing 桥 | `apps/windows/AirFerry.Windows/Scan/MatLuminanceSource.cs` | 紧凑 byte[] → LuminanceSource |
| 多文件包解包 | `apps/windows/AirFerry.Windows/Bundle/BundleParser.cs` | ETBUNDL1（字节级镜像 Kotlin BundleParser.kt） |
| **文字载荷解析** | `apps/windows/AirFerry.Windows/Bundle/TextParser.cs` | `IsText`/`Parse`（ETTEXTv1 → UTF-8）；字节级镜像 TS `text.ts` 与 Kotlin `TextParser.kt`。有跨平台单测 `TextParserTests.cs` |
| 文件名 sanitize | `apps/windows/AirFerry.Windows/Bundle/FileNameUtil.cs` | + Windows 保留名（CON/PRN/COM1-9）处理 |
| 主状态机 | `apps/windows/AirFerry.Windows/ViewModels/ScanViewModel.cs` | 编排采集→解码池→会话→恢复→落盘。`RecoverAndStage` 按 text→bundle→单文件顺序分流 |
| UI | `apps/windows/AirFerry.Windows/Views/*.xaml` | Scan/DeviceSelect/ReceiveDetail/ReceiveText/ReceiveBundle/FileList/Settings |
| **文字接收页（可复制/保存 .txt）** | `apps/windows/AirFerry.Windows/Views/ReceiveTextView.xaml` | `Clipboard.SetText` + SaveFileDialog UTF-8；RecoveryResult 新增 `Text`/`IsText` |

### 3.5 网页发送端

> **功能与浏览器扩展（§3.2）完全一致**，**直接复用 `apps/sender/src/` 全部源码，无代码重复**。下表只列 web 端特有的接入点；业务逻辑（页面/组件/worker/wasm）见 §3.2。

| 关注点 | 位置 | 说明 |
|--------|------|------|
| 薄入口（mount sender App） | `apps/web/src/main.tsx` | `import App from "@/options"`（alias → `../sender/src/options.tsx`）+ `createRoot().render(<App/>)`。仅此一个源文件是 web 专有 |
| Vite 配置（跨工程 alias） | `apps/web/vite.config.ts` | `resolve.alias: { "@/": "../sender/src/" }` —— sender 源码内部所有 `@/` 引用全部重定向到真实文件；worker 的 `new URL("./workers/...", import.meta.url)` 跨工程解析 |
| WASM 前置校验 + zstd 拷贝 | `apps/web/scripts/prepare-wasm.cjs` | `predev`/`prebuild` 跑：①校验 `apps/sender/wasm-pkg/transfer_engine.js` 存在（缺失报错指向 `cd apps/sender && npm run wasm`）；②拷 `@foxglove/wasm-zstd/dist/wasm-zstd.wasm` → `public/wasm-zstd.wasm`（worker 运行时 fetch） |
| lzma-wasm 提取 | `apps/web/scripts/extract-lzma-wasm.cjs` | 同 sender 版（base64 → 物理 .wasm，解 Rollup 静态分析）。`postinstall` 跑 |
| **环境自适应接入点** | `apps/sender/src/options.tsx` | 三环境共用同一份源码，按运行环境分流：① 扩展（`chrome.runtime.getURL`）② 网页普通版（`document.baseURI` fetch）③ **单文件版**（`globalThis.__AIRFERRY_STANDALONE__` 标志 → Blob URL worker + base64 WASM）。worker 初始化、zstd 预加载两处都做三路判断，扩展/普通版行为不变 |
| **base64 工具（单文件专用）** | `apps/sender/src/wasm/base64.ts` | `base64ToBuffer(b64)`：`atob` + Uint8Array，主线程/worker 共用。单文件版运行时把内联 base64 WASM 解码成 buffer，喂给 `init(buffer)`/`initZstdFromBytes` |
| 相对路径部署 | `apps/web/vite.config.ts` `base:"./"` | 产物 `dist/` 资源用 `./assets/...`，可部署到任意子路径（GitHub Pages 的 `user.github.io/repo/` 等） |
| **单文件构建配置** | `apps/web/vite.standalone.config.ts` + `apps/web/src/standalone.tsx` | IIFE bundle + worker 单独 ES chunk。`standalone.tsx` mount 前设 `__AIRFERRY_STANDALONE__=true` 触发单文件路径 |
| **单文件后处理** | `apps/web/scripts/build-standalone.cjs` | 把 Vite 多文件产物内联成单个 `dist-standalone/index.html`：注入 worker 源码（`__WORKER_CODE__`）+ zstd base64（`__WASM_ZSTD__`）+ process polyfill；处理 `</script>` 转义 + `import.meta.url` 替换 |

---

## 4. 调试速查表（症状 → 首查位置）

| 症状 | 首查 | 可能原因 |
|------|------|---------|
| 点扩展图标仍弹小窗（而非直跳 options） | `apps/sender/src/background/index.ts` + `fix-manifest.cjs` | manifest 残留 `default_popup`（popup 优先级高于 `onClicked`）；或 `src/popup.tsx` 误被恢复（Plasmo 据此重新注入 popup）。删 popup.tsx + `fix-manifest.cjs` 兜底删 `default_popup` 是触发 `onClicked` 的前提 |
| 文字传输收端当文件保存 | `TextParser.kt`/`TextParser.cs` + `text.ts` | 收端不认 ETTEXTv1 魔数 → 落到单文件兜底分支（向后兼容，存成 .txt 仍可打开）；确认魔数 8 字节位级一致 |
| 收端卡「恢复中 0%」 | `descriptor.rs:178 parse_payload` + `receiver.rs:147 ingest` | OTI 未确认（`meta_confirmed=false`）；描述符解析失败 |
| 收端崩溃（扫码即崩） | `meta.rs:97 validate` + `receiver.rs:208-222` 守卫 | 恶意/越界坐标未在入解码器前拦截（panic=abort 下致命） |
| 进度越往后越慢 | `sender.rs:235 next_symbol_id` | 必须是「源一遍→无限新鲜修复」，不能循环有限计划 |
| 帧被静默丢弃 | `frame.rs:122 from_bytes` | magic/version/双层 CRC 校验失败 |
| 恢复出空文件 | `descriptor.rs` v2/v3 消歧(line 173) + `compressed_size_known` | v3 尾部被误读为 v2 补零 |
| 解压 OOM / 崩溃 | `compress.rs:97 decompress_with_limit` | 炸弹上限未封顶到 `original_size` |
| JNI 摄入竞态/UAF | `QrDecodePool.ingestLock` + `ScanActivity` `ingestStopped` | 句柄非线程安全，未串行化 |
| 摄像头读不出码 | `qr_render.rs:74 encode`（版本选择）+ `scan_jni.cpp:64`（TryHarder） | 版本过高致模块过密；或 16KiB 页未对齐致 .so 加载失败 |
| 压缩总是走 raw（100%） | `compress.ts:163 initZstdFromBytes` | worker 内 zstd WASM 未加载成功 |
| **网页端压缩走 raw（100%）** | `apps/web/public/wasm-zstd.wasm` + `prepare-wasm.cjs` | `public/wasm-zstd.wasm` 缺失（未跑 `prebuild`），worker fetch 404 → 回退 raw。重新跑 `npm run build`（会触发 `prebuild`→prepare-wasm） |
| **网页端启动报 transfer_engine.js 找不到** | `apps/sender/wasm-pkg/` | web 复用 sender 的 Rust WASM，首次构建前需 `cd apps/sender && npm run wasm`。`prepare-wasm.cjs` 会校验并报清晰错误 |
| **`release`/`dist` 产物缺 web zip** | `apps/web/dist/` | `pack_dist` 用 warn 模式（非中断）：`apps/web/dist/` 缺失时跳过 web zip。先跑 `./scripts/build-all.sh web` 再 `dist`/`release` |
| 扩展构建缺 WASM | `apps/sender/wasm-pkg-legacy/` 或 `wasm-pkg-simd/` | 单独跑 `npm run build:chrome-mv3` 等单目标脚本前忘了先 `npm run wasm`（双产物缺失） |
| APK 缺 native 库 | `jniLibs/arm64-v8a/libtransfer_engine.so` | 手动跑 `./gradlew` 而未经 `build-all.sh`（后者已自动先跑 cargo-ndk） |
| Windows 端 DllNotFoundException | `apps/windows/AirFerry.Windows/runtime/transfer_engine.dll` | 手动跑 `dotnet build` 而未经 `build-windows.ps1`（后者已自动先跑 cargo --features cffi） |
| Windows 端 EntryPointNotFoundException | `apps/windows/AirFerry.Windows/Native/NativeBridge.cs` | `[DllImport]` 缺 `EntryPoint`：P/Invoke 默认按 PascalCase C# 方法名查找，但 Rust `cffi.rs` 导出的是 snake_case `airferry_*`。**首个 native 调用即抛**（热路径 `ReceiverIngest` → 扫第一个码就崩），CI 协议层单测测不到。修复：每个声明钉死 `EntryPoint = "airferry_receiver_ingest"` 等 |
| Windows 端设备打不开 | `DeviceEnumerator.cs` + `VideoCapture.cs` | 设备被其他程序独占；或 DirectShow 驱动问题（换 MSMF 后端或换设备） |
| Windows 端扫码即崩（Rust panic） | `cffi.rs` + `ReceiverSession.cs` | 同 Android：恶意/越界输入应在 Rust `Frame::from_bytes` 拦截；检查 `panic=abort` 下 DLL 是否正确编译 |

---

## 5. 文档与代码偏差清单（AI 高风险，务必注意）

> 调研发现多处文档滞后于代码。**修改/引用时一律以代码为准**。下面是已确认的偏差：

1. **`docs/api.md` JNI 签名过时**：
   - 写 `receiverIngest` 返回 `ByteArray?`（进度 JSON）—— **实际返回 packed `jlong` 位域**（`jni.rs:68`）。位布局见 [`docs/SPEC.md`](docs/SPEC.md) §JNI ingest 状态字。Kotlin 侧 `IngestStatus.unpack`（`ReceiverSessionManager.kt:67`）镜像此布局。
   - 写 `receiverAssemble(handle, outBuf): Int` —— **实际是 `receiverAssembleBytes(handle): ByteArray`**（原子返回完整字节，修复了 >2GB 截断 + 长度/填充竞态）。

2. **压缩参数（两端不同，勿混为一谈）**：
   - **浏览器发送端**（`apps/sender/src/wasm/compress.ts:55-64`）：Zstd **level 1**、Xz **level 9**、early-exit 阈值 **70%**（`e10079d`/`c2ae4a2` 提交已调；三算法选优 raw/zstd/xz）。
   - **Rust 核心库**（`core/qr-protocol/src/compress.rs:25,48`）：Zstd **level 22**（`DEFAULT_LEVEL`）、Xz **level 6 + EXTREME**（`XZ_PRESET`）。
   - 两端用不同级别是**有意的**：发送端追求压缩启动快（Lv1），接收端只做解压、用高 ratio（见 `compress.rs:42-44` 的 NOTE）。两端产物是标准 zstd/xz 流，互操作正确。引用压缩参数时**必须分清是 TS 端还是 Rust 端**，不要合并描述。

3. **版本号/Release 混用**：四处版本均为 `1.0.0`（`apps/sender/package.json`、`apps/scanner/app/build.gradle.kts` versionName、`Cargo.toml` workspace version、`apps/windows/AirFerry.Windows/AirFerry.Windows.csproj` `<Version>`），但 README 与 dist 历史里出现过 v1.0.0/v1.1.0 混用。改版本时四处同步，且 `scripts/build-all.sh` 的 release 打包文件名需同时改。

4. **高速录制模式为死代码**：`HighSpeedCaptureController.kt`、Settings 里的高速开关、`docs/architecture.md`/`data-flow.md` 的「实验性高速录制」段落——**当前代码中已禁用**（`ScanActivity` onCreate 中 `highSpeedEnabled = false`，UI 分支 `if (highSpeed)` 永不渲染）。文档仍当可用功能描述。

5. **`derive_meta_from_totals` 已废弃**：`receiver.rs:422`，仅保留 JNI ABI 兼容，**新代码勿调用**（其 OTI 构建在大文件上会 assert）。现代路径：从描述符帧拿权威 OTI。

6. **wasm-bindgen 双轨制（MV2=0.2.92 旧版 / MV3=0.2.125 新版）**：`core/transfer-engine/Cargo.toml` **默认仍钉死 `=0.2.92`**（js-sys/web-sys `=0.3.69`），**不要**改回宽松的 `"0.2"` / `"0.3"`——任何 `cargo update` 都会把默认 lockfile 漂移到 0.2.93+ 并破坏 MV2 构建。MV3 走另一条路：`apps/sender/scripts/build-wasm.cjs` 在构建 `wasm-pkg-simd/` 时**临时**把 Cargo.toml 改写成 `=0.2.125`（js-sys/web-sys `=0.3.102`）+ `RUSTFLAGS=+simd128`，构建完在 `finally` 里用 ① 内存回写 Cargo.toml + ② `git checkout Cargo.lock` 字节级还原，保证跑完后 `git status` 对 Cargo 文件零改动。
   - **为什么是双轨**：wasm-bindgen 0.2.93+ 默认开 reference-types proposal（`externref` 值类型），仅 Chrome 96+ 支持；Chrome 87/88 会在 `WebAssembly.instantiateStreaming()` 报 `CompileError: invalid value type 'externref'`。Chrome 87 是 MV2 的兼容目标。MV3 同时启用新版 externref（JS↔WASM 引用传递）+ SIMD（`+simd128` target-feature）。SIMD 本身与 wasm-bindgen 版本正交——0.2.92 也能开——但新版 externref 必须升 wasm-bindgen，MV3 默认把两者一起给。
   - **⚠️ 实测性能结论（不要据此期待提速）**：对当前 `next_qr_into` 全链路（RaptorQ 取符号 + Frame 序列化 + QR Reed-Solomon 编码 + 矩阵构建）的 Node benchmark（V25/1400B symbol、5000 帧）：
     - **SIMD vs 标量**：0.95×（**轻微变慢**）。`raptorq` 与 `qrcode` crate 均为纯标量 Rust，无 `std::arch::wasm32::*` SIMD intrinsics，`+simd128` 对它们毫无作用，只让 wasm 大 ~8KB（312KB vs 304KB）并因指令缓存压力略慢。
     - **新版 wasm-bindgen externref**：对 `&mut [u8]` 传递无明显收益（淹没在 QR 编码耗时里）。
     - **真实瓶颈是 QR 编码**：单帧 ~4.8ms，其中 QR Reed-Solomon + 矩阵构建占 ~98%，Frame 序列化 + 数据传递占 ~2%。要提速只能换更快的 QR 库（如 C 实现的 ZXing）、降 symbol size（低 QR 版本）、或多线程并行编码（需 SharedArrayBuffer + COOP/COEP）。
   - **那为什么还保留双产物 + SIMD**：① 双产物解决「MV2 兼容老 Chrome + MV3 用新工具链」的根本诉求（externref 错误的根治方案）；② 为未来引入 SIMD 化的库（换 QR 库、RaptorQ 用 GF(256) SIMD）保留构建基础设施——届时去掉/保留 `+simd128` 即可即时生效。
   - **产物分流**：`wasm-pkg-legacy/`（MV2 用，无 SIMD/externref）+ `wasm-pkg-simd/`（MV3 用，两者都有）。`build-all.cjs` 按 `target.endsWith('mv3')` 把对应目录复制到 `wasm-pkg/` 后 plasmo build。loader.ts 的 import 路径固定 `../../wasm-pkg/`，靠 swap 目录名切换。
   - **升级现代版**：改 `build-wasm.cjs` 顶部的 `MODERN = { wasmBindgen, jsSys, webSys }` 三元组，三者必须同期发版、版本号匹配（见 crates.io）。改完跑 `npm run wasm` 验证 `git status` 干净。
   - **症状定位**：若扩展在新 Chrome 正常、在旧 Chrome（87/88）报 `CompileError: invalid value type 'externref'`，即 MV2 产物意外用了新版 wasm-bindgen——检查 `build-all.cjs` 是否按 MV2/MV3 正确 swap。

7. **WASM 零拷贝 API**：`SenderSessionWasm` 同时提供 `next_qr`/`next_qr_multi`（返回 `Vec<u8>`，wasm-bindgen 深拷贝成新 `Uint8Array`）和 `next_qr_into`/`next_qr_multi_into`（写入调用方提供的 `&mut [u8]`，无分配）。**热路径（`QrStream.tsx` 的 rAF 循环）用 `_into` 变体**——组件用 `useRef` 预分配最大尺寸 buffer（V40=177²=31329 字节）跨帧复用。保留旧变体是为了备用路径/调试。**注意**：`_into` 写入的 subarray 视图只在当帧有效（下一帧会被覆盖），`drawMatrix` 必须在同一 tick 内 putImageData 完毕。
   - **⚠️ 实测性能结论**：零拷贝 vs 返回 `Vec` 实测 **0.99×（持平）**。QR 编码耗时（~4.8ms）完全主导，`Vec<u8>` → `Uint8Array` 的深拷贝（V25=13689 字节）相对可忽略。保留 `_into` 的真实价值不是单帧提速，而是**消除每帧的堆分配**（4码×60fps = 240 次/秒），降低 GC 压力（benchmark 测不到 GC 抖动，但长时间运行下 GC stall 会导致 rAF 周期性掉帧）。
   - **drawMatrix 像素填充**：当前是逐像素 `pixels[i] = black` 写（跳过白模块）。曾尝试用 `Uint32Array.set(blackRow, offset)` 批量复制整行黑模块，**实测 0.5×（慢一倍）**——`TypedArray.set` 对 modulePx=4~7 的小块有调用开销（边界检查 + memcpy setup），拐点在 modulePx ≥ 16。已回退，勿再尝试此「优化」。

8. **网页端（apps/web）零代码复用 sender**：web 工程通过 Vite alias `@/ → ../sender/src/` **直接跨工程 import** `apps/sender/src/options.tsx` 的 `App`，所有页面/组件/worker/wasm 模块都来自 sender，**不复制任何业务代码**。改 sender 业务代码，web 端自动同步。
   - **环境自适应（关键接入点）**：sender 源码里有两处扩展 API 调用，均已做环境判断，**扩展和网页共用同一份源文件**：
     - `options.tsx:42` zstd 预加载 IIFE：`typeof chrome !== "undefined" && chrome.runtime?.getURL` 为真走扩展路径，否则走 `new URL("wasm-zstd.wasm", document.baseURI)`。
     - `compress.ts:186` worker 内 zstd 加载 fallback：`new URL("wasm-zstd.wasm", self.location.href)`。
   - **WASM 依赖关系**：web 构建复用 `apps/sender/wasm-pkg/`（Rust WASM），不自己编译 Rust。`apps/web/scripts/prepare-wasm.cjs`（`predev`/`prebuild`）校验存在性 + 拷贝 `wasm-zstd.wasm` 到 `public/`。
   - **不要在 web 里 fork 业务代码**：若要改发送逻辑，改 `apps/sender/src/`（单一事实源），两端同步生效。web 的 `src/main.tsx` 只应是 mount 入口，不承载业务逻辑。

---

## 6. 架构关键不变量（速览，详见 [`docs/SPEC.md`](docs/SPEC.md)）

- **同一份 Rust 源码** → 三个 FFI 目标：浏览器 `wasm32-unknown-unknown`（wasm-bindgen）、Android `aarch64-linux-android`（`#[no_mangle] extern "system"` JNI）、Windows `x86_64-pc-windows-msvc`（`#[no_mangle] extern "C"` C ABI，供 .NET P/Invoke）。编解码数学一致。
  - **浏览器扩展（apps/sender）与网页端（apps/web）共用同一份 WASM**（`apps/sender/wasm-pkg/transfer_engine_bg.wasm`）和同一份 TS 源码（`apps/sender/src/`）。web 通过 Vite alias 跨工程 import，**不单独编译 Rust、不复制业务代码**。三个 FFI 目标实际对应**四个发布端**（扩展 MV2/MV3 共用一份 wasm、网页复用同一份、Android、Windows）。
- **帧格式**：`[Header 60B][Payload T][Footer 4B]`，大端，magic `0x4554`，version 1，双层 CRC32；T=symbol_size（浏览器默认 1400——`DEFAULT_CONFIG.symbolSize`，核心库默认 1024——`Config::default()`）。
- **会话 ID**：FNV-1a 128-bit（name/size/mtime/指纹），确定性 → 断点恢复。Rust 与 TS 实现必须位一致。
- **喷泉码发射**：源符号跨块轮询发一遍 → 无限新鲜修复符号（ESI 单调递增、永不重复）。进度近似线性，无 coupon-collector 拖尾。
- **接收端安全生命线**：`panic = "abort"` 构建，任何 panic = 进程崩溃。`ObjectMeta::validate` + `decompress_with_limit` 是把恶意/越界输入挡在解码器前的防线。
- **线程模型**：原生 receiver 句柄**非线程安全**。Android 用一把 `ingestLock` 串行化所有摄入；ZXing 解码在 N 个 worker 上并行。

---

## 7. 约定

- **语言**：文档、提交信息均用中文；代码注释中英混合（Rust 偏英文 doc-comment，TS 偏英文）。
- **构建 profile**：`release` 用 `opt-level="z"` + LTO + `panic="abort"`（求小体积）；但热路径 crate（raptorq-core / qr-protocol / raptorq / qrcode / crc32fast / transfer-engine）单独提升到 `opt-level=3`（见 `Cargo.toml`）。
- **不提交产物**：`target/`、`wasm-pkg/`、`build/`、`dist/`、`*.so`、`*.apk`、`*.pem`、`*.keystore` 均在 `.gitignore`。
- **修改帧/协议字段**：两端（Rust + TS + Kotlin）必须同步；更新 [`docs/SPEC.md`](docs/SPEC.md) 的位级规格。
- **改码即改文档（AI 硬性收尾）**：每次改动代码后，凡是影响文档中引用过的**事实**——常量值、默认值、`file:line` 行号、函数签名、帧/字段布局、文件路径、目录结构、构建命令、版本号——都必须在**同一个提交**里回写对应文档（AGENTS.md 的 §3 导航 / §4 调试表 / §5 偏差清单，或 `docs/SPEC.md` 的权威源/速查表，或具体 `docs/*.md`）。改了哪一端，就核对该端在文档里的所有引用点。提交前自检：「本次改的符号/常量/路径，在文档里被引用过吗？被引用的地方还成立吗？」**不更新文档的代码改动视为未完成**。这是防止文档再次漂移的唯一手段，也是上一轮 SPEC.md/AGENTS.md 互相矛盾（浏览器默认 512 vs 1400）的根本成因——代码改了，文档没跟上。

## 8. 权威文档索引

| 主题 | 文档 |
|------|------|
| 跨端契约（位级不变量） | [docs/SPEC.md](docs/SPEC.md) |
| 协议规范 | [docs/protocol.md](docs/protocol.md) |
| 帧格式 | [docs/qr-frame-format.md](docs/qr-frame-format.md) |
| RaptorQ 参数 | [docs/raptorq-params.md](docs/raptorq-params.md) |
| 系统架构 | [docs/architecture.md](docs/architecture.md) |
| 数据流 | [docs/data-flow.md](docs/data-flow.md) |
| API 参考（⚠️ JNI 部分已过时，见 §5） | [docs/api.md](docs/api.md) |
| 构建指南 - 浏览器 | [docs/build-browser.md](docs/build-browser.md) |
| 构建指南 - 网页端 | [docs/build-web.md](docs/build-web.md) |
| 构建指南 - Android | [docs/build-android.md](docs/build-android.md) |
| 构建指南 - Windows | [docs/build-windows.md](docs/build-windows.md) |
| 开发环境搭建 | [docs/dev-setup.md](docs/dev-setup.md) |
