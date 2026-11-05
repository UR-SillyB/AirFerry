# AGENTS.md — AI 代理操作手册

> 本文是给 AI 代理（以及人类开发者）的**导航 + 操作索引**：怎么构建、怎么定位代码、怎么排错、哪些坑别踩。
> 本文**不重复** `docs/*.md` 的细节，每条都指向权威来源。跨端不变量的位级规格见 [`docs/SPEC.md`](docs/SPEC.md)。
> **遇到文档与代码冲突时，一律以代码为准**（见下方「文档与代码偏差清单」）。
> **当本文与 `docs/SPEC.md` 互相矛盾时**（如默认值、常量、行号），先去读对应权威源代码裁决——两份文档都可能滞后，切勿仅凭其中一份下结论。
> **每次改动代码后，必须同步更新相关文档**：改动若涉及常量、默认值、行号、签名、帧格式、文件路径、构建步骤等任一被文档引用的事实，**同一提交内**回写 AGENTS.md / docs/*.md 的对应位置，勿留滞后（本次审计即是文档滞后于代码的教训）。

## 项目一句话

**AirFerry**：完全离线的光学文件传输。发送端把文件编成二维码视频流在屏幕上连续播放，也可由 Python 包输出 MP4；接收端用摄像头或屏幕捕获扫描恢复文件。各端共享同一套 Rust 核心库（WASM、Android Native `.so`、Windows DLL、Python/PyO3 扩展），编解码逻辑数学上一致。**零运行期网络依赖、单向信道、无握手**。

---

## 1. 仓库布局

```
AirFerry/
├── core/                       # Rust 协议核心（三个核心 crate；workspace 另含 apps/python）
│   ├── raptorq-core/           #   RFC 6330 RaptorQ 编解码封装（纯逻辑）
│   ├── qr-protocol/            #   帧格式 / 分块 / 压缩 / CRC / QR 矩阵 / 会话 ID
│   ├── transfer-engine/        #   编排 / 状态机 / 进度 / 断点 / 大文件分段组装 + WASM&JNI&C-ABI 绑定
│   └── zxing-decoder/          #   Windows ZXing-C++ 解码核心（非 Cargo crate）
├── apps/
│   ├── sender/                 # 浏览器扩展（Plasmo + React + TS + WASM）
│   │   ├── src/                #   TS 源码（页面 / WASM 桥 / 压缩 worker / background 图标点击直跳）
│   │   ├── wasm-pkg/           #   当前扩展目标的临时 WASM 快照（generated, git-ignored）
│   │   ├── assets/             #   扩展图标
│   │   └── scripts/            #   构建 / manifest 修正 / lzma-wasm 提取
│   ├── web/                    # 网页端（Vite + React + TS）— 直接复用 sender/src 源码，无代码重复
│   │   ├── src/main.tsx        #   薄入口：mount sender 的 App（options.tsx）
│   │   ├── scripts/            #   prepare-wasm（锁定并复制 sender simd 包 + 拷 zstd）/ lzma 提取
│   │   └── public/             #   wasm-zstd.wasm（worker 运行时 fetch，构建时拷入）
│   ├── scanner/                # Android App（Kotlin + CameraX + ZXing-C++）
│   │   └── app/src/main/
│   │       ├── java/com/airferry/app/   # Kotlin
│   │       ├── cpp/                     # ZXing-C++ JNI 桥（CMake）
│   │       └── jniLibs/arm64-v8a/       # Rust .so（cargo-ndk 产物, git-ignored）
│   ├── python/                 # Python 文件转 MP4（PyO3 + Pillow + 本地 FFmpeg；独立包版本）
│   └── windows/                # Windows App（C# WPF + OpenCvSharp + ZXing-C++）
│       ├── native/                     #   Windows ZXing C ABI 包装器 + CMake
│       ├── AirFerry.Windows/            #   主项目（Views/ViewModels/Models/Scan/Bundle/Native/Services/Themes；WPF-UI Fluent 主题）
│       │   └── runtime/                 #   transfer_engine.dll + airferry_zxing.dll（git-ignored）
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
# 三个核心 crate 的单元 + 集成测试（根目录 default-members）
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
#     • wasm-pkg-simd/   — wasm-bindgen =0.2.125（隔离副本升级）、标量、含 externref
#       → `simd` 为保留的历史目录/参数名；Chrome 96+/FF 116+ 支持 externref，供 MV3 使用
#   ⚠️ 工作树隔离：build-wasm.cjs 只复制 core 与根 Cargo 文件到临时目录，把副本
#       workspace 的 members/default-members 投影为原三个核心 crate，排除宿主
#       Python/PyO3 crate；仅在现代副本把 wasm-bindgen/js-sys/web-sys 升级并重算 lockfile。源码 Cargo.toml /
#       Cargo.lock 从不写入；脚本还用 `.wasm-build.lock` 阻止两个 WASM 构建互相覆盖。
#   说明: `wasm` feature 已隐含 `serde`（见 core/transfer-engine/Cargo.toml）。
#   ⚠️ 实测结论（见 §5 第6条）：当前 raptorq/fast_qr 的 wasm32 热路径无 SIMD
#       intrinsics；旧 `+simd128` 构建约 0.95×，反而略慢且 wasm 大 ~8KB，并在部分
#       加固/虚拟化 Chromium 中编译失败。现在两份产物都是标量；双产物的价值是
#       「MV2 兼容老 Chrome + MV3 使用新 wasm-bindgen/externref」。

# ② 构建扩展（全部 4 个目标，会自动先跑 extract-lzma-wasm + build-wasm.cjs）
npm run build
#   等价: extract-lzma-wasm.cjs && build-wasm.cjs（双 wasm 产物） && build-all.cjs
#   build-all.cjs 按 MV2/MV3 把对应 wasm-pkg-* 目录复制到 wasm-pkg/ 后再 plasmo build：
#     chrome-mv3 / firefox-mv3 → wasm-pkg-simd/   复制为 wasm-pkg/
#     chrome-mv2 / firefox-mv2 → wasm-pkg-legacy/ 复制为 wasm-pkg/
#   loader.ts 通过 `@airferry-wasm` alias 指向 `wasm-pkg/`，靠 swap 目录名切换。
#   产物: apps/sender/build/{chrome,firefox}-{mv2,mv3}-prod/

# 单独构建某个目标（不自动跑 wasm 双产物，需先 `npm run wasm`）
npm run build:chrome-mv3     # 或 :chrome-mv2 / :firefox-mv3 / :firefox-mv2

npm run dev                  # Plasmo HMR 开发模式

# WASM 隔离回归（2 项，含临时 workspace 的 cargo metadata --offline）
node --test scripts/test-build-wasm.cjs
```

| 目标目录 | 支持浏览器 |
|---------|-----------|
| `chrome-mv3-prod` | Chrome / Edge（MV3） |
| `chrome-mv2-prod` | Chrome / Edge（MV2 遗留） |
| `firefox-mv3-prod` | Firefox 116+ |
| `firefox-mv2-prod` | Firefox 91+ |

### 2.3 Android 扫码端（apps/scanner）

```bash
# ① 构建 APK（Gradle 的 compileRustJni task 会自动先用 cargo-ndk 重编 Rust JNI，
#    无需手动前置 cargo ndk）
cd apps/scanner
./gradlew :app:assembleDebug      # 调试 APK
./gradlew :app:assembleRelease    # 发布 APK（必须配置 keystore.properties；缺失即失败）
#   产物: app/build/outputs/apk/{debug,release}/app-*.apk

adb install app/build/outputs/apk/release/app-release.apk
```

> **Rust JNI 自动重编（v1.2.0 防护 ①）**：`assembleDebug`/`assembleRelease` 的
> `merge*JniLibFolders` 前置依赖 `compileRustJni`，后者先跑
> `cargo ndk -t arm64-v8a -o apps/scanner/app/src/main/jniLibs build -p transfer-engine --features jni --release`
> 再打包 → 本地构建的 APK 永远不打包旧 `.so`（修复：设备上显示 1.2.0/versionCode 14
> 但 APK 内 JNI 库是旧版、缺 v5 分段代码 → 安卓扫码 >32 MiB 一直「正在同步」，
> Web 用最新 WASM 不受影响）。
> **Native ABI 版本握手（v1.2.0 防护 ②）**：`ScanActivity` 启动自检先调
> `NativeBridge.nativeAbiVersion()` 并断言 `>= NATIVE_ABI_VERSION(1)`
> （= jni.rs `AIRFERRY_NATIVE_ABI_VERSION`，对应 descriptor-v5 分段能力）。旧 `.so`
> 缺符号抛 `UnsatisfiedLinkError` 或报更低版本 → 直接 `ErrorScreen`「原生库版本过旧」，
> 不伪装可用。

> ZXing-C++（`libairferry_zxing.so`）由 Gradle 的 CMake 任务在首次 APK 构建时从 GitHub 拉取 v3.0.2 自动编译（需网络；缓存后离线可用）。
> **16 KiB 页对齐**：Android 15+ 的 16 KiB 页设备会拒绝 `dlopen` 仅 4 KiB 对齐的 `.so`（表现：所有 QR 解码静默失败）。`cpp/CMakeLists.txt` 用 `-Wl,-z,max-page-size=16384` 强制对齐；Rust `.so` 由 cargo-ndk 默认对齐。验证：`llvm-readelf -l lib*.so | grep LOAD`（Align 列应为 `0x4000`）。

### 2.4 Windows 扫码端（apps/windows）

```powershell
# 首选：PowerShell 原生脚本（须 Windows + .NET 8 SDK + CMake/VS C++）
.\scripts\build-windows.ps1           # 构建（Rust DLL + ZXing-C++ DLL + WPF）
.\scripts\build-windows.ps1 -Pack     # 构建 + 打包到 dist/

# 或 Git Bash/WSL 下用 build-all.sh 的 windows 子命令（逻辑等价）
./scripts/build-all.sh windows
```

> **WPF 只能在 Windows 上构建**（`net8.0-windows` TFM 依赖 Windows SDK）。
> **托管层单元测试**（`AirFerry.Windows.Tests`）用纯 `net8.0`，可在任何 OS 上跑（协议、文件导出、池化缓冲及 native packed 结果解析；不实际加载 P/Invoke DLL）：
> ```bash
> cd apps/windows && dotnet test    # 任意 OS
> ```
> 详见 [`docs/build-windows.md`](docs/build-windows.md)。

### 2.5 网页端（apps/web）

```bash
cd apps/web
npm install            # 首次（含 postinstall: 提取 lzma-wasm）

npm run dev            # Vite HMR 开发（http://localhost:5180）
npm run build          # 产出**发送端**静态站点 dist/（index.html 单入口，可部署任意静态托管）
npm run build:receiver # 产出**接收端**静态站点 dist-receiver/（receiver.html 单入口，独立 zip）
npm run build:receiver:standalone # 产出**接收端单文件** dist-receiver-standalone/index.html（双击即用，Chrome/Edge file://）
npm run build:standalone  # 产出发送端自包含单文件 dist-standalone/index.html（双击即用，file:// 可运行）
npm run preview        # 本地预览构建产物
```

> **复用 sender 源码，零代码重复**：web 端是薄入口（`src/main.tsx` 只 mount sender 的 `App`），通过 Vite alias `@/ → ../sender/src/` 直接跨工程 import `apps/sender/src/` 的全部页面/组件/worker/wasm 模块。改 sender 业务代码，web 端自动同步。
>
> **唯一前置依赖**：web 构建复用 `apps/sender/wasm-pkg-simd/`（Rust WASM 现代产物）。首次构建前需在 sender 下先跑一次 `npm run wasm`。`predev`/`prebuild` 会持构建锁校验并复制到 web 自有 `apps/web/wasm-pkg/`，缺失时报清晰错误；web 与扩展的并发构建不会相互切换依赖目录。
>
> **环境自适应**：sender 的 `options.tsx` 用 `typeof chrome` 判断 —— 扩展走 `chrome.runtime.getURL`，网页走 `new URL(..., document.baseURI)`。`compress.ts` 的 worker 内 zstd 加载同样有网页 fallback。两端共用同一份 `options.tsx`，扩展行为不变。
>
> **部署**：`dist/` 是纯静态文件，资源用相对路径（`base: "./"`），可放 GitHub Pages / Netlify / 任意静态服务器的任意子路径。`wasm-zstd.wasm` 在产物根目录供 worker 运行时 fetch。核心传输**不需要** COOP/COEP 头（不依赖 SharedArrayBuffer）。详见 [`docs/build-web.md`](docs/build-web.md)。
>
> **单文件版（`npm run build:standalone`）**：产出**单个 `dist-standalone/index.html`**（约 2MB），所有 JS/CSS/Worker/WASM 内联（WASM 转 base64），**双击即可在 `file://` 下运行**，无需服务器。原理：① Vite IIFE bundle（去 ES module 标记，绕过 file:// 的 module 限制）；② worker 源码字符串化后用 Blob URL 加载（绕过 file:// 的 Worker 限制）；③ 三个 WASM base64 内联 + 复用现成 buffer 接口（`init(buffer)` / `initZstdFromBytes` / lzma 自带 base64，绕过 file:// 的 fetch 限制）。`build-standalone.cjs` 后处理脚本完成内联，并处理 `</script>` 转义、`import.meta.url` 替换、`process` polyfill 三个细节。sender 源码（`options.tsx`/`loader.ts`）通过 `globalThis.__AIRFERRY_STANDALONE__` 标志做环境自适应，扩展/web 普通版不受影响。
>
> **网页接收端（v1.1.6 新增，`receiver.html`）**：v1.1.6 起发送端与接收端**分开构建、独立 zip**——`npm run build` 产出发送端 `dist/`（index.html 单入口），`npm run build:receiver` 产出接收端 `dist-receiver/`（receiver.html 单入口），打包为 `airferry-sender-web-v{VER}.zip` + `airferry-receiver-web-v{VER}.zip` 两个独立可部署产物（发送端 zip 排除 `zxing_reader.wasm`）。接收端用浏览器 `getUserMedia` 拿摄像头（**三级 fallback**：后置高分辨高帧率 → 后置无约束 → 默认摄像头 `true`，缓解「Starting videoinput failed」——某些摄像头/驱动对严格 constraint 集或 facingMode 不兼容；**`frameRate:{ideal:60,max:60}`** 钉住上限确保 60fps 摄像头真给 60，否则 ideal 软约束常被降 30fps → Web 卡 120 码/s）。进入接收页先在原黑框位置的**来源选择卡**（`.source-select`，`startSelectedSource` 分流）选摄像头或**屏幕捕获**再点「开始接收」：屏幕捕获走 `navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:60,max:60}}})`——只钉帧率（分辨率随捕获面原生，桌面 ≥1080p），由「开始接收」点击手势触发浏览器选择器；`NotAllowedError`（用户取消选择器）**安静留在选择页**（不算错误）；`track.onended` 监听浏览器「停止共享」→ `teardown()` 回来源选择（recovering/done 阶段不依赖流，忽略）；屏幕捕获预览给 video 加 `.camera-video.contain`（object-fit:contain，**防 cover 裁掉屏幕边缘的码**——取帧走 canvas 的 videoWidth/Height 原生分辨率，CSS 只影响预览）；`typeof navigator.mediaDevices?.getDisplayMedia === "function"` 探测，手机浏览器等不支持时该选项**自动隐藏**（UI 与旧版一致）。`requestVideoFrameCallback` 取帧（**1080 全分辨率，不 downscale**），经 **QR decode worker 池**（`zxing-wasm/reader` 兼容路径，**`QR_WORKER_POOL=4` 个 worker 并行解码**跨核分摊帧率，镜像 Android 线程池；**整帧全图解码**，zxing `maxNumberOfSymbols:4` 在多码任意位置都能检出——不用固定 ROI，真实手机拍摄码偏移/倾斜时 ROI 会把码切半导致难扫）→ **receive worker**（单例，`ReceiverSessionWasm` **串行** ingest + `assemble_raw` + JS 侧 zstd/xz 解压 + CRC 校验 + 文字/包/单文件分流）。源码在 `apps/sender/src/{pages/ReceivePage.tsx, receive/{decompress,parse}.ts, workers/{receive,qr-decode}.worker.ts}`，web 入口 `apps/web/src/receiver.tsx` + `apps/web/receiver.html`。Vite 多页面（`rollupOptions.input`）+ `worker.format:"es"`（worker 含 dynamic import 需 ES 格式）。`zxing-wasm` 与 `lzma-wasm` 装在 web 的 node_modules，用 alias 指向其 dist 入口（sender/node_modules 无此包）。`prepare-wasm.cjs` 额外拷 `zxing_reader.wasm` 到 `public/` 供 worker 运行时 fetch。发送端与接收端 web **拆为两个独立 zip**（`airferry-sender-web-v{VER}.zip` / `airferry-receiver-web-v{VER}.zip`），各自自包含可独立部署。**两种发布形态**：① **多文件版**（`receiver.html` / `dist-receiver/`），部署到 HTTPS/localhost，适合手机/局域网；② **单文件版（v1.2.9 新增）**：`npm run build:receiver:standalone` 产出 `dist-receiver-standalone/index.html`，内联主 bundle + receive/qr 两个 Worker + `transfer_engine`/zstd/FAST ZXing/`zxing_reader` 全部 WASM，**Chrome/Edge 双击在 `file://` 下即用**（约 6.4 MB）。原理：主 bundle 为 IIFE；Worker 源码字符串化后用 **module Blob URL** 启动；receive Worker 预置 `__WASM_TRANSFER_ENGINE__`，QR Worker 预置 `__ZXING_FAST_JS__`/`__ZXING_FAST_WASM__`/`__ZXING_READER_WASM__`；FAST 用 `wasmBinary` + `locateFile` 避免 fetch（Blob 模块的 `import.meta.url` 不能做相对基址），兼容后端 `locateFile` 返回 wasm Blob URL。`ReceivePage.tsx` 的 `createReceiveWorker`/`createQrWorker` 仅在 `__AIRFERRY_STANDALONE__` 下走 Blob 路径，普通 web/扩展不变。**⚠️ 网页接收端限制**：① 多文件版不能双击——module 脚本/Worker/WASM 是独立文件；② 多文件版需 HTTPS/localhost（`getUserMedia` 安全上下文）；单文件版在 Chromium 的 `file://` 下可用（Chrome 153 实测 `isSecureContext=true`、`navigator.mediaDevices` 存在、`getUserMedia` 与 Blob module worker 均可用），Safari/Firefox 未验证；③ 速度低于原生——JS/WASM 解码 + 浏览器摄像头管道，结构性慢于 Android/Windows 原生（C++ 多线程 + SIMD），追求满速扫码建议用原生接收端。局域网一键启动：`cd apps/web && node scripts/serve-https.mjs dist-receiver .cert/selfsigned.crt .cert/selfsigned.key 8765`。
>
> **接收端 UI 复用发送端设计系统**：`ReceivePage.tsx` 样式从 `app.css` 抽离为独立 `apps/sender/src/assets/receive.css`（发送端 `app.css` 不再含 `.receive-*`）。接收端 JSX 复用发送端骨架（`.app` / `.app-header` / `.app-logo` / `.app-main` / `.app-footer`），色值一律走 `app.css` 设计 token（`--color-primary`/`--color-card`/`--color-border`/`--color-success`/`--color-error` 等），无硬编码色；进度条/参数卡/结果卡/按钮与发送端同源观感。接收端专属结构（`.receive-header`/`.camera-area`/`.source-select`/`.source-option`/`.fps-badge`/`.progress-*`/`.result-area`/`.bundle-*` 等）定义在 `receive.css`。`.receive-page` 复用 `.app` 的 720px 居中布局但设 `justify-content:flex-start`（相机+进度卡可能超一屏，`center` 会裁剪顶部）。发送端使用 `assets/icon*.png`（悬浮显示面播放连续 QR 帧），接收端使用 `assets/receiver-icon*.png`（取景框扫描 QR 帧）；Web 的 `index.html` / `receiver.html` 分别引用 `public/favicon-sender.png` / `public/favicon-receiver.png`，单文件发送端构建把 sender favicon 内联为 data URL。

### 2.6 一键脚本 `scripts/build-all.sh`

| 子命令 | 动作 | 是否自动跑 cargo 前置 |
|--------|------|---------------------|
| `all`（默认） | `build_sender` + `build_web` + `build_scanner` | ✅（scanner） |
| `sender` | 双 wasm 产物 + 扩展 4 目标 | — |
| `web` | 先 `npm run wasm` 重编 WASM + `build-fastzxing.sh --use-cache` 重编 FAST ZXing-C++，再 `npm run build` + `npm run build:receiver` + `npm run build:receiver:standalone`（apps/web；发送端 dist/、接收端 dist-receiver/、接收端单文件 dist-receiver-standalone/；`prebuild*`→prepare-wasm 复制私有快照 + 拷 `wasm-zstd.wasm`/`zxing_reader.wasm`/`airferry_zxing.*`） | ✅（wasm 自动） |
| `scanner` | `cargo ndk` 编译 `.so` → `./gradlew assembleRelease` | ✅ |
| `windows` | Rust C ABI DLL + 共享 ZXing-C++ DLL → `dotnet build`（须 Windows） | ✅ |
| `wasm` | 仅 `npm run wasm`（= build-wasm.cjs，产 legacy + simd 两份） | — |
| `dist` | **仅打包**：把已构建的 `build/` + APK + Windows zip + web 两端 zip + 发送端/接收端单文件 html 复制/签名到 `dist/`（不重新构建） | — |
| `dist-upload-list` | **仅打印**可安全上传到 GitHub Release 的当前版本产物清单（`airferry-*-v{VER}.` + 扩展名白名单，物理排除 `*.pem`/`*.keystore` 密钥）；不构建不打包，供 `gh release upload` 命令替换使用 | — |
| `release` | `build_sender` → `build_web` → `build_scanner` → `pack_dist`（全量构建 + 打包） | ✅（scanner） |

```bash
./scripts/build-all.sh              # 构建 sender + web + scanner（不打包）
./scripts/build-all.sh release      # 全量构建 + 打包到 dist/（最常用）
./scripts/build-all.sh dist         # 仅打包（假设已构建好，不重新编译）
./scripts/build-all.sh dist-upload-list  # 打印可安全上传 Release 的产物清单（排除密钥）
./scripts/build-all.sh sender       # 仅浏览器端（含 WASM）
./scripts/build-all.sh web          # 仅网页端（须先有 apps/sender/wasm-pkg-simd/）
./scripts/build-all.sh scanner      # 仅 APK
./scripts/build-all.sh windows      # 仅 Windows 端（须 Windows + .NET 8 SDK + CMake/VS C++；首选 build-windows.ps1）
./scripts/build-all.sh wasm         # 仅 WASM
```

**脚本行为要点**（权威源 `scripts/build-all.sh`）：
- **版本号**：从 `apps/sender/package.json` 的 `version` 读取（`read_version()`），与扩展 manifest 同源。改版本改这一处即可被脚本读取，但 APK/扩展本身的版本号仍需手动同步（见 §2.7）。
- **`build_scanner` 自动跑 cargo-ndk**：在 `./gradlew assembleRelease` **之前**先用 `cargo ndk -t arm64-v8a ... build -p transfer-engine --features jni --release` 编译 `libtransfer_engine.so` 到 `jniLibs/`。这是为了避免打进过期 `.so`（AirFerry 重命名后旧符号 `com.easytransfer.*` 与 Kotlin 新包名对不上会 `UnsatisfiedLinkError` 闪退）。因此 `scanner`/`all`/`release` 子命令都自带这步，无需手动前置。
- **`build_windows` 自动构建两个 native 前置**：在 `dotnet build` **之前**先用 cargo 编译 `transfer_engine.dll`，再用 CMake/VS C++ 编译并测试 `airferry_zxing.dll`；二者都复制到 `runtime/`。Android 直接保留 v1.1.3 的 `scan_jni.cpp`，Windows 通过 `core/zxing-decoder/` 镜像同一解码选项与全帧/ROI 调度模式。**Windows 端只能在 Windows + .NET 8 SDK + CMake/VS C++ 下完整构建**，首选 `scripts/build-windows.ps1`。
- **`build_web` 先重编原生 lib 再构建**：v1.2.0 起 `build_web` **不再只是复制旧中间产物**，而是先 `build_wasm`（`npm run wasm` 重编 `wasm-pkg-simd/`）+ emcc 可用时调 `scripts/build-fastzxing.sh --use-cache`（重编 FAST ZXing-C++ `airferry_zxing.js/.wasm` 到 `apps/sender/src/fastzxing/`），再 `cd apps/web && npm run build` + `npm run build:receiver` + `npm run build:receiver:standalone`（发送端站点、接收端多文件站点、接收端单文件）。`prebuild` 的 `prepare-wasm.cjs` 校验 `wasm-pkg-simd/{transfer_engine.js,transfer_engine_bg.wasm}`、持共享构建锁原子复制到 web 自有 `apps/web/wasm-pkg/`，再拷 `wasm-zstd.wasm` + `zxing_reader.wasm` + `airferry_zxing.*` 到 `public/`。**emcc 缺失时显式 `warn`（不静默），接收端回退 zxing-wasm 兼容后端，构建不中断**——发布前请在带 Emscripten 的环境运行 `./scripts/build-fastzxing.sh` 以确保 FAST 快路径最新。`pack_dist` 用 warn（非 error）模式打包 web zip——产物缺失时跳过而非中断，因为用户可能只发扩展+APK 不发网页端。
- **Chrome crx 签名**：调用 macOS Chrome 的 `--pack-extension` + `--pack-extension-key`。私钥必须预先位于 `dist/airferry-extension.pem`；脚本核对固定公钥 SHA-256 后才签名，缺失/换钥直接失败，绝不自动生成新 ID。找不到 Chrome 二进制时跳过 crx、仅留 zip。
- **`pack_dist` 会清旧产物**：删 `dist/airferry-{receiver-android-*.apk,receiver-windows-*.zip,receiver-web-*.zip,sender-chrome-*.crx,sender-chrome-*.zip,sender-firefox-*.xpi,sender-web-*.zip}`，但**不动** `*.pem` 和 `*.keystore`。**⚠️ 正因密钥与产物同处 `dist/`，上传 Release 绝不要用裸 `dist/*` 通配（会把密钥一起上传外泄）**——始终用 `$(./scripts/build-all.sh dist-upload-list)` 取扩展名白名单清单（`.apk/.zip/.crx/.xpi/.html`，物理排除密钥；见下方「发布流程」与 `release_upload_list()`）。

### 2.7 构建目录布局

三层产物目录，**全部 git-ignored**（见 `.gitignore`）：

```
源码 ──构建──► 中间产物目录 ──打包──► dist/（发布）
```

| 目录 | 内容 | 来源 | git-ignored |
|------|------|------|-------------|
| `apps/sender/wasm-pkg-legacy/` | WASM 编译产物（wasm-bindgen 0.2.92 / 标量 / 无 externref，Chrome87-safe）；供 MV2 目标使用。内含 `.gitignore` 为 `*`（全忽略） | `npm run wasm:legacy`（由 build-wasm.cjs 调度） | ✅ |
| `apps/sender/wasm-pkg-simd/` | WASM 编译产物（wasm-bindgen 0.2.125 / 标量 / 含 externref）；`simd` 为历史兼容名，供 MV3 目标使用。内含 `.gitignore` 为 `*`（全忽略） | `npm run wasm:simd`（由 build-wasm.cjs 调度） | ✅ |
| `apps/sender/wasm-pkg/` | **临时**目录：build-all.cjs 在每次 plasmo build 前按目标把 `wasm-pkg-legacy/` 或 `wasm-pkg-simd/` 复制到这里（`@airferry-wasm` alias 指向它）。不长期存在 | `build-all.cjs` 的 `useWasmPkg()` | ✅ |
| `apps/web/wasm-pkg/` | **web 私有快照**：prepare-wasm 持锁从 sender 的现代产物原子复制；避免与扩展目标切换竞态 | `predev`/`prebuild`/`prebuild:standalone` | ✅ |
| `apps/sender/build/` | Plasmo 扩展构建产物：`{chrome,firefox}-{mv2,mv3}-prod/` 四个目录 + 构建期生成的 `.crx`/`.xpi`/`.zip` | `npm run build` | ✅ |
| `apps/web/public/wasm-zstd.wasm` | zstd WASM，构建时由 `prepare-wasm.cjs` 从 `@foxglove/wasm-zstd/dist/` 拷入，供 worker 运行时 fetch | `predev`/`prebuild`（prepare-wasm.cjs） | ✅ |
| `apps/web/dist/` | Vite 网页构建产物：`index.html` + `assets/`（JS/CSS/wasm/worker）+ 根目录 `wasm-zstd.wasm`。相对路径 `base:"./"`，可部署到任意子路径 | `npm run build` | ✅ |
| `apps/web/dist-receiver/` | 接收端多文件站点：`receiver.html` + `assets/` + `wasm-zstd.wasm` + `zxing_reader.wasm` + `airferry_zxing.*` | `npm run build:receiver` | ✅ |
| `apps/web/dist-standalone/` | 发送端单文件中间产物（后处理前） | `npm run build:standalone` | ✅ |
| `apps/web/dist-receiver-standalone/` | 接收端单文件中间产物；完成后只剩 `index.html` | `npm run build:receiver:standalone` | ✅ |
| `apps/scanner/app/build/` | Gradle/APK 构建产物：`outputs/apk/{debug,release}/app-*.apk` + native-debug-symbols + baselineProfiles | `./gradlew` | ✅ |
| `apps/scanner/app/src/main/jniLibs/arm64-v8a/` | Rust 编译的 `libtransfer_engine.so`（唯一 native 库；旧的 `libet_code.so` 已清理，Kotlin 侧仅有 `System.loadLibrary("transfer_engine")` / `System.loadLibrary("airferry_zxing")`）。ZXing 的 `libairferry_zxing.so` 不在此处——由 CMake 在 APK 构建时直接编译进 APK | `cargo ndk ... build` | ✅ |
| `apps/windows/AirFerry.Windows/bin/` `obj/` | C# WPF 构建产物：`bin/x64/Release/net8.0-windows/win-x64/` + OpenCV/native DLLs | `dotnet build` / `dotnet publish` | ✅ |
| `apps/windows/AirFerry.Windows/runtime/transfer_engine.dll` | Rust 编译的 C ABI DLL（`--features cffi`）；csproj 显式纳入 build/publish 并扁平复制到 exe 同目录，打包脚本再显式复制+核验 | `cargo build`（由 build-windows.ps1 拷入） | ✅ |
| `apps/windows/AirFerry.Windows/runtime/airferry_zxing.dll` | Windows 对 Android v1.1.3 模式的 C ABI 等价实现；作为独立 native DLL 放在 exe 同目录，打包时显式复制+核验 | `cmake --build apps/windows/native/build`（由 build-windows.ps1 拷入） | ✅ |
| `apps/windows/native/build/` | Windows ZXing-C++ 配置、依赖与 CTest 产物 | CMake（首次配置按固定 commit 获取 zxing-cpp） | ✅ |
| `dist/` | 发布归档 + 签名材料（`*.pem` Chrome 私钥、`airferry-release.keystore`） | `pack_dist` | ✅ |
| `target/` | Rust 编译缓存（workspace 共享） | `cargo` | ✅ |

> 构建产物**绝不提交 git**。分发走 GitHub Release，产物放 `dist/`。

### 2.8 产物格式与命名规范

发布归档统一格式 `airferry-{角色}-{平台及变体}-v{版本}.{扩展}`，**角色前缀进文件名**：

- `sender` = **发送端**（浏览器扩展 / 网页）：把文件编成二维码视频流在屏幕上播放
- `receiver` = **接收端**（Android / Windows App）：用摄像头 / 采集卡扫码恢复文件

> **asset 不设 label**（Release 资产的「下载说明」字段留空，GitHub 页面直接显示文件名）。各端的用途、系统要求、架构、变体差异等**写在 Release notes 的产物表**（见各版 `docs/releases/v{VER}.md` 与 README 下载表）和文件名本身里，不重复进 label——文件名已含角色+平台+变体+版本，足够区分。

| 产物 | 命名格式 | 格式说明 |
|------|---------|---------|
| Android 接收端 APK | `airferry-receiver-android-arm64-v{VER}.apk` | **Android 扫码端**。arm64-v8a 单 ABI；Android 10+（minSdk 29）；安装后对准屏幕二维码即可接收。必须用 `apps/scanner/keystore.properties` 指向的 release keystore 签名；缺失时 release 构建失败，打包还会用 `apksigner` 拒绝 debug/无效签名 |
| Windows 接收端 zip | `airferry-receiver-windows-x64-v{VER}.zip` | **Windows 扫码端**。x64 单架构；Windows 10+，需安装 .NET 8 Desktop Runtime；视频源支持摄像头 + USB/HDMI/SDI 采集卡 + 屏幕区域/独立窗口捕获（截图式选择器，见 §3.4）。`dotnet publish` 单文件 + 框架依赖；内含 `AirFerry.exe` + `transfer_engine.dll` + `airferry_zxing.dll` + OpenCV native DLLs。**只能在 Windows 上构建**（WPF TFM） |
| Chrome MV3 | `airferry-sender-chrome-mv3-v{VER}.crx` + `.zip` | `.crx` = Cr24 签名格式（Chrome 96+/Edge 96+，现代 WASM externref）；`.zip` = 解压目录打包回退（`.crx` 被商店外安装拦截时用） |
| Chrome MV2 | `airferry-sender-chrome-mv2-v{VER}.crx` + `.zip` | 同上，旧版浏览器兼容 |
| Firefox MV3 | `airferry-sender-firefox-mv3-v{VER}.xpi` | Firefox 116+；`.xpi` 本质是 zip 改名 |
| Firefox MV2 | `airferry-sender-firefox-mv2-v{VER}.xpi` | Firefox 91+ |
| 网页发送端 | `airferry-sender-web-v{VER}.zip` | 纯静态站点（`index.html` + `assets/` + 根目录 `wasm-zstd.wasm`）；Vite `base:"./"` 相对路径，可部署到任意静态托管的任意子路径。v1.1.6 起**仅含发送端**（`build_web` 产 `apps/web/dist/`，打包排除 `zxing_reader.wasm`）。`pack_dist` 自动打包（须先跑 `build-all.sh web`，缺失时 warn 跳过） |
| 网页接收端 | `airferry-receiver-web-v{VER}.zip` | **接收端多文件 zip**（`receiver.html` + assets + `wasm-zstd.wasm` + `zxing_reader.wasm`）。v1.1.6 起与发送端 web 拆分，可独立部署；`build:receiver` 产 `apps/web/dist-receiver/`。⚠️ **不能双击运行**（Worker/WASM 是独立文件），需部署到 HTTPS / localhost。`pack_dist` 自动打包（缺失时 warn 跳过） |
| 网页接收端单文件 | `airferry-receiver-web-standalone-v{VER}.html` | **单个自包含 HTML**（约 6.4 MB），内联主 bundle + receive/qr Worker + `transfer_engine`/zstd/FAST ZXing/`zxing_reader` WASM（base64）。**Chrome/Edge 双击在 `file://` 下即用**，无需服务器；Safari/Firefox 的 `file://` 摄像头未验证。由 `npm run build:receiver:standalone` 产出 `apps/web/dist-receiver-standalone/index.html`；`build_web` 自动复制到 `dist/`，`pack_dist` 也按 warn 模式补回 |
| 网页发送端单文件 | `airferry-sender-web-standalone-v{VER}.html` | **单个自包含 HTML**（约 2MB），所有 JS/CSS/Worker/WASM 内联（WASM 转 base64），**双击在 `file://` 下即用**，无需服务器。由 `npm run build:standalone` 产出 `apps/web/dist-standalone/index.html`。**v1.2.0 起 `build_web` 自动构建并按版本规范复制到 `dist/`**（`airferry-sender-web-standalone-v{VER}.html`），随 `release`/`all`/`web` 一并产出，纳入发布流程——不再手动改名上传 |

#### 发布流程（GitHub Release 怎么来）

1. **本地构建打包**：`./scripts/build-all.sh release`（macOS/Linux）→ 产出 `dist/` 下除 Windows 外的全部产物（扩展 4 目标 crx/zip/xpi + Android APK + web 两端 zip + 发送端/接收端单文件 html）。Windows zip 单独在 Windows 上用 `.\scripts\build-windows.ps1 -Pack` 或走 `.github/workflows/windows.yml` 的 `windows-pack` job（见 §2.9）。
2. **创建/更新 Release**：`build-all.sh release` 内部 `pack_dist` 只把产物放进 `dist/`，**不自动上传 GitHub**。发版时手动：
   ```bash
   gh release create v{VER} -R UR-SillyB/AirFerry \
     --target <commit-sha> --title v{VER} \
     --notes-file docs/releases/v{VER}.md        # 创建（首次）
   # ⚠️ 绝不要用裸 dist/* 通配——dist/ 还存放 airferry-extension.pem（Chrome 签名
   # 私钥）与 airferry-release.keystore（Android 发布 keystore），裸通配会把密钥
   # 一起上传造成外泄。用脚本生成的扩展名白名单清单（仅产物，物理排除密钥）：
   gh release upload v{VER} -R UR-SillyB/AirFerry \
     $(./scripts/build-all.sh dist-upload-list) --clobber   # 上传/覆盖 asset
   ```
   Windows asset 由 `windows.yml` 的 `windows-pack` job 自动 `gh release upload --clobber`（仅传单个 Windows zip，CI 干净 checkout 无密钥）。
3. **重新发布同一 tag（需改 notes / 重排 asset / 清 label 时）**：保留 tag 以维持下载链接稳定，只重建 release 记录：
   ```bash
   gh release delete v{VER} -R UR-SillyB/AirFerry --yes --cleanup-tag=false   # 删 release，保留 tag
   gh release create v{VER} -R UR-SillyB/AirFerry --target <tag-commit> --title v{VER} --notes-file docs/releases/v{VER}.md
   gh release upload v{VER} -R UR-SillyB/AirFerry \
     $(./scripts/build-all.sh dist-upload-list) --clobber   # 重新上传（仅产物，排除密钥）
   ```
   `gh release upload` **不写 label**（label 留空，按本节规范）。历史版本（v1.0.0–v1.1.3）文件名不含角色前缀，属历史命名，不回改。

**扩展产物内部结构**（每个 `*-prod/` 目录）：
- `manifest.json`——由 `scripts/fix-manifest.cjs` 后处理：复制真实 RGBA 图标覆盖 Plasmo 占位图、MV2 删 `action` 留 `browser_action` 并把 CSP 改为 `wasm-eval`、Firefox 补 `browser_specific_settings.gecko.id = airferry@airferry.app`、修补 HTML `<title>`
- `transfer_engine_bg.wasm` + `wasm-zstd.wasm` + `lzma-wasm.wasm`——运行时加载的 WASM 模块
- 图标 `icon{16,32,48,64,128}.png`

> MV2 与 MV3 用同一 Chrome 签名私钥打包会得到**相同的扩展 ID**（`lgafjpalpcbiellnlbfdabdlbfooojjm`），便于升级替换。该 ID 由固定私钥公钥 SHA-256 的前 128 位按 Chrome 规则换算，并与 v1.2.7–v1.2.9 CRX3 头部的 `crx_id` 一致。

### ⚠️ 关键依赖顺序（最容易踩的坑）

1. **WASM 双产物必须先于扩展构建**：`npm run build` 已内嵌 `build-wasm.cjs`（产 `wasm-pkg-legacy/` + `wasm-pkg-simd/`）再 `build-all.cjs`，故一条命令搞定。但**单独跑 `npm run build:chrome-mv3` 等单目标脚本不自动跑 wasm**——需先 `npm run wasm` 产出双产物，否则 `build-all.cjs` 的 `useWasmPkg()` 会因 `wasm-pkg-*/` 缺失报错退出。（`build-all.sh sender/release` 走 `npm run build`，不会踩坑。）
2. **JNI `.so` 必须先于 APK 构建（v1.2.0 起已由 Gradle 自动保证）**：Gradle 的 `compileRustJni` task（`merge*JniLibFolders` 的前置）会在打包 APK 前自动 `cargo ndk ... build` 产出最新 `libtransfer_engine.so` 到 `jniLibs/`——**手动 `./gradlew` 也不用再先跑 cargo-ndk**。`build-all.sh` 的 `scanner`/`all`/`release` 子命令仍额外先跑一次 cargo-ndk（双保险，见 §2.6）。历史坑（v1.2.0 之前）：手动 `./gradlew` 而未经脚本会打进过期 `.so` → 扫码端运行时 `UnsatisfiedLinkError` 或 >32 MiB 传输「正在同步」卡死。
3. **两个 native DLL 都必须先于 C# 构建**：cargo 产出 `transfer_engine.dll`，CMake 产出 `airferry_zxing.dll`，二者放入 `runtime/` 后 `dotnet build` 才会打包到 exe 同目录。**`build-windows.ps1`/`build-all.sh windows` 会自动构建、测试并复制二者**（见 §2.5）；若只手动跑 `dotnet build`，运行时会在引擎或二维码解码的首个 P/Invoke 处抛 `DllNotFoundException`。
4. **`dist` 子命令不重新构建**：它假设 `apps/sender/build/` 与 APK 已就绪（Windows zip 可选），只做复制/签名/打包。缺 sender/scanner 产物会 `error` 退出；缺 Windows 产物则 `warn` 跳过（因为 Windows 端只能在 Windows 上构建）。web 四件套（发送端/接收端 zip + 发送端/接收端单文件 html）同样 `warn` 模式：中间产物（`apps/web/dist*/`）在则从源重建，不在则跳过——**注意 `pack_dist` 开头清旧产物会删掉 `dist/` 里旧的两个单文件版 html**，所以单独跑 `dist` 前须保证 `apps/web/dist-standalone/index.html` 与 `apps/web/dist-receiver-standalone/index.html` 存在，否则对应单文件版会从发布清单消失。
5. **版本号同步（发版必查）**：`build-all.sh` 的发布文件名版本取自 `apps/sender/package.json`；下列**全部**须同一版本号：
   - `apps/sender/package.json` `version` + `manifest.version`（→ 扩展/打包文件名）
   - `apps/scanner/app/build.gradle.kts` `versionName`（+ 通常 `versionCode++`）（→ APK 内嵌）
   - `Cargo.toml` `[workspace.package] version`（→ 核心库）
   - `apps/windows/AirFerry.Windows/AirFerry.Windows.csproj` `<Version>`（→ exe 内嵌）
   - `apps/web/package.json` `version`（→ web 包自身版本）
   - 两个 `package-lock.json`（sender/web）只**手工改自身 `version` 字段两处**（根 + `packages[""]`），**勿用 `npm install --package-lock-only` 重生成**——v1.2.7 曾用它刷新 lock，结果剪掉了 `react@18.3.1` 等依赖条目（-76 行），`pages.yml` 的 `npm ci` 因 lock 与 package.json 不同步直接失败。改完用 `npm ci --ignore-scripts --dry-run` 验证同步
   - Windows CI 不保存版本副本；手动触发时输入已存在的 `release_tag`，workflow 校验 tag commit 与 package/manifest 后派生文件名

### 2.9 Windows 发版（GitHub Actions workflow）

> macOS/Linux **不能**本地编 WPF。正式 Windows 产物走 CI：`.github/workflows/windows.yml`。

| Job | Runner | 触发 | 作用 |
|-----|--------|------|------|
| `rust-cffi` | ubuntu | push/PR（core/windows 路径）+ `workflow_dispatch` | `cargo test/build --features cffi` |
| `csharp-tests` | ubuntu | 同上 | `dotnet test` 协议层及 packed QR 结果解析（不加载 native DLL） |
| `windows-build` | windows-2022 | 同上 | cargo + CMake/CTest 生成两个 native DLL → `dotnet build` WPF；固定 runner 以匹配 VS 2022 CMake generator |
| `windows-pack` | windows-2022 | **仅** `workflow_dispatch`（且前三 job 通过） | 重建两个 native DLL → `dotnet publish` 单文件 → zip → Release |

**发版步骤（Windows 端）**：

1. 把上表代码版本改到目标版本，提交、创建 tag，并先创建对应 Release。
2. 本地（或其它 CI）先打好 sender/APK/web 并创建/上传 GitHub Release tag `v{VER}`。
3. GitHub → Actions → **windows** → **Run workflow**，输入该现有 tag（如 `v1.2.3`）；workflow 会核对 tag、checkout commit 与 package/manifest 版本。手动发布与 push 质量门使用不同 concurrency group，不会互相取消。
4. 跑完后 Release 上应有 `airferry-receiver-windows-x64-v{VER}.zip`（`--clobber` 可覆盖同名 asset；asset 不设 label，见 §2.8）。

本地 Windows 机仍可用 `.\scripts\build-windows.ps1 -Pack` 等价打包到 `dist/`，但**默认发布路径是 workflow**。

### 2.10 Python 文件转视频包（apps/python）

```bash
# 仓库根目录；源码安装需 CPython 3.10+、Rust stable 和本机 C 编译器
python -m pip install "./apps/python[test]"
python -m pytest apps/python/tests
cargo test -p airferry-python

# wheel + sdist（不上传）
python -m pip install "maturin>=1.15,<2" build twine
python -m build --wheel --sdist apps/python --outdir dist/python
```

包版本独立为 `0.1.0`（`apps/python/Cargo.toml`），maturin 从 crate 读取版本，最低要求 1.15；发行名/导入名为 `airferry`，尚未发布 PyPI。`file_to_video(input_path, output_path, ...)` 和 `airferry input output.mp4` 将单文件转换成有限 H.264 MP4。默认 30fps、单码、1400B symbol、4px/模块、50% 修复比例（至少 8 个修复符号），支持四码和 descriptor-v5 大文件分段；每段每次传输至少 1 秒，补足帧继续产生新修复符号。参见 [`docs/build-python.md`](docs/build-python.md) 与 `apps/python/README.md`。

**离线编码与存储**：安装阶段可以联网；安装后压缩、RaptorQ、QR 与视频编码在本机完成，无在线服务、遥测或运行期组件补下载。FFmpeg 来自已安装 `imageio-ffmpeg` wheel，缺失即报错。文件 I/O 遵循操作系统路径语义：输入、输出、临时目录可使用 UNC、映射盘、reparse point、符号链接及 NFS 等正常文件系统路径，`file://` URL 转成文件系统路径（含 UNC 主机）；其他 URL 取决于文件 I/O 适配，当前未提供 HTTP 上传协议。网络存储读写可能产生网络流量，不属于编码调用线上服务。FFmpeg 的 `file,pipe` 设置保留操作系统网络文件系统访问。临时磁盘容纳原始快照与压缩候选，RaptorQ 按当前压缩段使用内存。测试覆盖真实离线编码。重复播放/`repeats` 不增加独立喷泉码，数字 MP4 往返测试不等于手机光学实测；Linux/macOS 真实 CI 尚待运行。

**构建隔离**：Python 是根 workspace 的额外成员，`default-members` 保持原三个核心 crate；普通 `cargo test` 不要求 Python 构建环境。Python crate 的直接 `fast_qr` path 依赖用于确保 maturin sdist 纳入 workspace vendored patch，不能因未直接引用而删除；pyproject 排除缓存与旧 dist 产物。`.github/workflows/python.yml` 构建 Windows/Linux x64 和 macOS x64/arm64 abi3 wheel、sdist，检查源码包 QR 文件完整及无旧制品，再从 sdist 重建 wheel 并运行 WASM 隔离测试；只保存 CI artifacts，不发布 PyPI。`build-all.sh` 的既有 release/dist 流程不纳入 Python 包。

---

## 3. 代码导航地图（file:line 索引）

### 3.1 核心库热路径

| 关注点 | 位置 | 说明 |
|--------|------|------|
| 编码器（源符号 O(1) + 按需修复） | `core/raptorq-core/src/encoder.rs:67,77` | `source_symbol` / `repair_symbols` |
| 解码器（任意顺序符号 + 块满即解） | `core/raptorq-core/src/decoder.rs`（`add_symbol`） | 含 ESI/载荷越界守卫 |
| **安全闸门** OTI 校验 | `core/raptorq-core/src/meta.rs:116` | `ObjectMeta::validate`——接收前必跑，防 panic-on-abort |
| **帧解析热点** | `core/qr-protocol/src/frame.rs`（`from_bytes`） | magic/version/双层 CRC 校验 |
| 帧封装 | `core/qr-protocol/src/frame.rs`（`build` / `to_bytes`） | |
| 会话 ID 派生（FNV-1a 128） | `core/qr-protocol/src/session.rs:23` | `derive`——必须与 TS 端位一致 |
| 压缩分发 + 解压炸弹防护 | `core/qr-protocol/src/compress.rs:139,170` | `compress_with` / `decompress_with_limit`；zstd 解码路径统一经 `zstd_decoder()` 钳制窗口 `ZSTD_WINDOW_LOG_MAX=23`（:81，防恶意帧头强制 128 MiB 窗口分配；编码端同步封顶 23 保证自产流可解） |
| QR 矩阵（动态最小版本） | `core/qr-protocol/src/qr_render.rs`（`encode` / `min_version_for`） | fast_qr；1464B(T=1400)→V27，1088B(T=1024)→V23，576B(T=512)→V16 |
| **发送端帧流入口** | `core/transfer-engine/src/sender.rs`（`next_frame`） | 每17帧插描述符，首帧即描述符；17 与 2/4 多码布局互质，描述符会轮转所有物理码位，勿改回 16 |
| 持续新鲜修复符号 | `core/transfer-engine/src/sender.rs`（`next_symbol_id`） | 源一遍→不重复修复；ESI 达 2²⁴ 时明确停止 |
| **接收端摄入入口** | `core/transfer-engine/src/receiver.rs`（`pub fn ingest`） | 缓存引导→描述符确认 OTI→喂解码器；预描述符 `symbol_cache` 上限 `pre_meta_cache_max()` 动态缩放（下限 `PRE_META_SYMBOL_CACHE_MAX`=12000，预算 `MAX_OBJECT_BYTES`≈32 MiB）。**完成后守卫**：对象解码完成后，后续数据帧一律按 duplicate 计数早退、不入 per-block `received` 集合、不增 `received_symbols`——CRC 非认证器，恶意屏可持续喂 CRC-valid 的新鲜修复 ESI，否则集合/计数无界增长构成慢速内存 DoS 且进度可 >100%；descriptor 路径不受影响（分段的下一段描述符照常摄入），resume 不序列化 `received` 亦不受影响 |
| 描述符载荷解析 | `core/transfer-engine/src/descriptor.rs`（`parse_payload`） | v1/v2/v3 + v2/v3 消歧；v5 分段尾段构造用 `build_segment_payload`，v5 解析统一在 `parse_payload` 内（无独立 `parse_segment_payload`） |
| 大文件分段（descriptor v5，压缩后分段） | `core/transfer-engine/src/segment.rs` + `assembler.rs` | 逻辑传输整段压缩一次后按**压缩字节流**切成段；固定 `SEGMENT_RAW_BYTES = MAX_OBJECT_BYTES − MAX_SYMBOL_SIZE ≈ 31.9 MiB`、`MAX_SEGMENT_COUNT=131072`。104B v5 尾部携带 `root_sha256`（解压后原文摘要）+ `raw_sha256`（本段压缩字节摘要），强制 child id / 压缩流大小 / 段数 / 规范偏移 / 压缩长度 ≤ 规范切片。接收端按序拼接压缩段后**只解压一次**，再校验长度 + CRC32 + 根摘要；原生端用 `qr_protocol::compress::decompress_stream_to_file` **流式解压写盘**（bounded RAM，>256 MiB 超大文件可收）。`TransferAssembler` 仅是便利内存实现；Web 用 IndexedDB，Android/Windows 用磁盘 `.partial` |
| 进度快照 | `core/transfer-engine/src/progress.rs` | `Progress` / `Stats` |
| 断点状态序列化 | `core/transfer-engine/src/resume.rs` + `receiver.rs` | `ResumeState`（serde-gated JSON）；JSON 封顶 128 MiB，恢复前校验 OTI/坐标/预算；**只有带载荷的符号才可回放并计入 received**。descriptor 后为控内存不保存全部 decoder 输入，普通当前对象重启需重扫；大文件跨重启靠宿主“已完成段”账本 |
| **JNI 绑定（Android）** | `core/transfer-engine/src/jni.rs` | `receiverIngest` 返回**packed jlong**（非 JSON，见 SPEC §7）；descriptor-v5 getter 含 `receiverRootSha256` / `receiverRawSha256`（WASM/C-ABI 同构） |
| **C-ABI 绑定（Windows）** | `core/transfer-engine/src/cffi.rs` | 分段 getter 含 `airferry_receiver_root_sha256` / `airferry_receiver_raw_sha256`；Windows `NativeBridge.cs` + `ReceiverSession.cs` 对应转发 |
| **C ABI 绑定（Windows/.NET P/Invoke）** | `core/transfer-engine/src/cffi.rs:106` | `airferry_receiver_ingest` 返回**packed u64**（位布局三端共享 `ingest_status.rs`）；assemble 用「Rust 分配+free」单次调用 |
| **WASM 绑定（浏览器）** | `core/transfer-engine/src/wasm.rs` | **发送端** `SenderSessionWasm`：`next_qr` / `next_qr_multi` 为兼容 API；热路径用 `next_qr_scratch` 写入会话内固定缓冲，再用 `qr_scratch_view` 取得当帧 WASM 视图。**接收端** `ReceiverSessionWasm`（v1.1.6 新增，网页接收端用）：`from_descriptor`（校验完整帧 CRC+描述符 flag→锁定 session id→摄入使 meta confirmed）/ `new(sid_lo,sid_hi)` 缓存引导 / `ingest` 返回**packed u64**（位布局三端共享，见 §SPEC ingest 状态字）/ 元数据 getters（`file_name`/`original_size`/`compressed_size`/`compression`/`crc32`/`*_known`/`meta_confirmed`）/ `assemble_raw`（**只重组不解压**，JS 侧用 zstd/xz WASM 解压 + 校验 CRC32）/ `progress_json`。**不暴露 `assemble_result`**（wasm32 解压 fail-closed，见 §5 第10条） |
| **Windows 相机 QR 解码核心** | `core/zxing-decoder/` | Windows C ABI 对 Android v1.1.3 ZXing 选项、全帧/多 ROI 与结果打包模式的等价实现；不是 Cargo crate |

### 3.2 浏览器发送端

| 关注点 | 位置 | 说明 |
|--------|------|------|
| 主应用（4 页路由） | `apps/sender/src/options.tsx`（`export default function App`） | select→params→play→stats；WASM session 用独立 owner ref + 幂等释放，覆盖 epoch 失效/替换/StrictMode 卸载，禁止双重 `free()` |
| **图标点击直跳（MV2/MV3 兼容）** | `apps/sender/src/background/index.ts` | `chrome.action.onClicked`/`browserAction.onClicked` → 新标签页打开 options。**无 `default_popup`**（popup.tsx 已删），listener 才会触发；有 popup 时 onClicked 永不触发 |
| popup（仅启动器） | ~~`apps/sender/src/popup.tsx`~~ | **已删除**——图标点击改为直接跳转，不再弹小窗 |
| **QR 渲染循环** | `apps/sender/src/components/QrStream.tsx`（`QrStream` / rAF loop） | Canvas2D rAF 每次可见刷新调用 `next_qr_scratch` / `qr_scratch_view`；`fps=0` 也只推进一次可见帧 |
| 单次 putImageData 绘制 | `apps/sender/src/components/QrStream.tsx`（`drawMatrix`） | 模块展开为像素后每码一次 putImageData |
| **文字传输魔数（ETTEXTv1）** | `apps/sender/src/wasm/text.ts` | `buildTextPayload`/`isTextPayload`；与 `bundle.ts` 的 ETBUNDL1 并列。**单条纯文字**走 ETTEXTv1（收端 `ReceiveText` 可复制/分享/存 .txt）；描述符 filename = 选择页用户命名（默认 `文字消息.txt`）；**混发**时文字以命名 `.txt` 进 ETBUNDL1 |
| **三算法选优压缩** | `apps/sender/src/wasm/compress.ts`（`preparePayload`） | raw/zstd/xz，早期退出阈值 **70%** |
| 压缩 worker（离主线程） | `apps/sender/src/workers/compress.worker.ts` | 读→压缩一次→CRC32→会话 ID。**descriptor-v5 大文件分段（压缩后分段）**：对文件/多文件包/文字统一整段压缩，若压缩流 > `SEGMENT_RAW_BYTES` 则把它切成多个段，一次 `done` 携带全部段（各自 transferable）。每段 `raw_sha256`=本段压缩字节摘要、`root_sha256`=解压后原文摘要、`original_size`/`compression`/`crc32`=整份原文属性（跨段一致）、`compressed_size`=本段压缩字节数；child id=`deriveSegmentId(root,i)`。接收端按序拼接压缩段后只解压一次 |
| WASM 加载器 | `apps/sender/src/wasm/loader.ts:27` | `ensureWasm` 一次性初始化 |
| 会话 ID（TS 端，镜像 Rust） | `apps/sender/src/wasm/session.ts:17` | `deriveSessionId` |
| 多文件容器 | `apps/sender/src/wasm/bundle.ts` | 打包格式（ETBUNDL1）；产品上限 4096 项、原始内容硬限 256 MiB。Android/Windows `ContentStore.putBytesBatch` 一次发布整批索引，避免 O(n²) 重写 |
| 4 个页面 | `apps/sender/src/pages/*.tsx` | FileSelect / Params / Play / Stats |
| **选择页（统一列表）** | `apps/sender/src/pages/FileSelectPage.tsx` + `options.tsx` + `types.PendingItem` | 无 Tab：上方按钮——**添加文件夹**（`showDirectoryPicker`/`<input webkitdirectory>`，递归加入）+ **添加文字**（弹窗，**保留 content**，文件名文案「收端展示/落盘名」）；**添加文件**由下方大拖放区（全页拖放/点选，追加）承担；全页拖放仅拦截文件，文件夹会递归读取；**仅**点「发送」才 stage。改列表/回步骤 1 会作废在途压缩（epoch/`jobId`）。`1×text`→ETTEXTv1；否则→`processFiles`/ETBUNDL1 |
| 文字文件名规范化 | `apps/sender/src/storage/textDrafts.ts` | 仅 `normalizeDraftFilename`（IndexedDB 草稿已移除） |
| **文本类可复制** | Android `TextLike.kt` / Windows `FileNameUtil.IsTextLikeName` | 扩展名启发式（txt/md/json/csv/源码…）：单文件、打包条目、历史列表均可进 `ReceiveText` 复制/分享/存盘。ETTEXTv1 仍优先 |

| manifest 前/后处理 | `prepare-plasmo-icon.cjs` + `fix-manifest.cjs` | 前者从 icon128 生成 git-ignored 的 `assets/icon.png`（clean build 必需）；后者写入各尺寸图标/MV2 CSP/Firefox id，并兜底删 `default_popup` |
| **★网页接收端（v1.1.6 起）** | `apps/sender/src/pages/ReceivePage.tsx` | 浏览器无磁盘流式编解码器，恢复时在 **JS 内存**里整份解压并校验（根 SHA-256 + CRC32），上限 `MAX_DECOMPRESSED_BYTES`=256 MiB（见 §3.2「接收端解压 + 解析」行）；完成后经 `showSaveFilePicker` 一次性写盘（`writable.write(file.data)`），无该 API 时 Blob 下载回退硬限 64 MiB（`FALLBACK_BLOB_MAX_BYTES`），防止合并超大根文件耗尽内存。**扫码来源选择**（camera 阶段 `.source-select` 卡）：摄像头（三级 fallback）或屏幕/标签页捕获（`getDisplayMedia`，细节见 §2.5；`track.onended` 处理浏览器「停止共享」，预览 `.contain` 防裁边，不支持时选项自动隐藏）；`startSelectedSource` 统一供「开始接收」与历史「继续恢复」使用（恢复分段任务也可用屏幕捕获）。web 入口 `apps/web/src/receiver.tsx` + `apps/web/receiver.html` |
| **接收端解压 + 解析** | `apps/sender/src/receive/{decompress,parse}.ts` | `decompressAndVerify`：NONE 原样/ZSTD 复用 sender 的 zstd Emscripten 单例（`zstdDecompress`）/XZ 用 `lzma-wasm`（**必须先 `await lzma.initWasm()` 再 `decompress`**，否则抛 `Please call initWasm()...`，曾漏掉），浏览器无磁盘流式编解码器，原始内容上限 `MAX_DECOMPRESSED_BYTES`=256 MiB（峰值约 `compressedSize + ~2× decompressedSize`，JS 内存约束；原生端流式解压不受此限，wire 上限仍为 `MAX_OBJECT_BYTES`=32 MiB）+ CRC32 校验。**zstd 字节由主线程预加载**：`ReceivePage` 在 post `init` **之前** `await wasm/zstdPreload.ts` 的 `preloadZstdBytes()`（三环境：standalone base64 / 扩展 getURL / 网页 document.baseURI；fetch 带 5s `AbortController` 超时——挂起而非快速 404 的连接不会卡死启动，超时回 null 走懒加载兜底）并 post `wasm-init`——worker 消息 FIFO 保证它先于任何 frames/assemble 被处理（不可 fire-and-forget：慢网络下 assemble 会先让 `getWasm()` 启动兜底 fetch，晚到的 `wasm-init` 只重置下一次调用，在途解压仍失败），worker 内 `initZstdFromBytes` 安装。兜底 fetch 的基 URL **按执行环境分流**（`compress.ts` `fetchAndInstantiate`）：主线程（含 ReceivePage 保存已完成分段任务时的主线程解压）走 `document.baseURI` 同级路径（子路径部署正确）；打包 worker（脚本在 `assets/` 下）走 `../wasm-zstd.wasm` 上跳一级（与 qr-decode worker 的 locateFile 同约定）——曾统一按 worker 相对路径解析到 `assets/wasm-zstd.wasm` → 404（文件在站点根），导致所有 zstd 压缩传输完成时报错（raw 小文件不触发）。`parseRecovered`：ETTEXTv1→text（超 256 KiB 内联上限→**剥 8 字节 magic 后按 .txt 文件**分流，三端一致）/ ETBUNDL1→bundle / 否则→单文件（字节级镜像 Android/Windows） |
| **receive worker** | `apps/sender/src/workers/receive.worker.ts` | descriptor-v5 解压后强制 CRC32、`raw_sha256`、规范坐标并冻结跨段 `root_sha256`；`taskStore.ts` 同一 IDB 事务提交 Blob+账本，写前检查 storage estimate。普通结果用 transferable ArrayBuffer 回主线程，避免 structured clone 复制。**会话引导/失配重锁（sessionGuard）**：引导探针与描述符候选统一经 `receive/sessionGuard.ts`（纯函数，`scripts/test-receive-guard.mjs` 单测 = `npm test`）——缓存引导探针**必须**验帧 magic/version（防环境二维码 URL/支付码供给垃圾 session id 把 worker 永久锁死在错误会话）；ingest 循环内 `!meta_confirmed && !everAccepted && mismatchStreak≥3` 时 `dropSession()` 重锁（`MISMATCH_RELOCK_THRESHOLD=3`，镜像 Android/Windows mismatch re-init；带 `jobId===activeJobId` 陈旧任务守卫，重锁后快照解析有空守卫），`everAccepted` 随 `dropSession()` 重置。init 就绪屏障期间 worker `error` 事件直接 fail-fast（#15 前只报 8s 超时），超时文案附 Edge 增安模式等排查方向 |
| **QR decode worker（池）** | `apps/sender/src/workers/qr-decode.worker.ts` + `ReceivePage` 池管理 | **双后端**：① **FAST（M3 快路径，默认）**：自编译 ZXing-C++→WASM（`fastzxing/airferry_zxing.js/.wasm`，Emscripten 3.1.64 + `-O3` 标量构建），吃 **Y 灰度平面**（主线程 `extractYPlane` = **canvas drawImage + getImageData + RGBA→Y**，stride 严格 = width）。**⚠️ 不要用 `VideoFrame.copyTo(I420)` 取 Y**：I420 的 Y 平面按 coded-stride(≥width)/codedWidth(≥displayWidth) 布局，`subarray(0,w*h)` + `rowStride=width` 会行错位、WASM 解不出（曾因此「扫不出来」）。canvas RGBA→Y 布局确定，虽然多一次 RGBA 转换，但正确。worker `decodeFastY` 调 `airferry_wasm_decode_multi_y`（复用 `core/zxing-decoder/airferry_zxing_core.cpp` 纯 C++，与 Windows/Android 同源）。实测合成四码 598px **10.4ms**（vs zxing-wasm ~22ms，~2×+）。**⚠️ 编译必须 `-fexceptions` + `-s STACK_SIZE=1MiB` + 固定 64MiB 内存（`ALLOW_MEMORY_GROWTH=0`）+ `EXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAPU32`，并用 `em++` 链接 C++ 异常运行时**：ZXing-C++ 在 1080p 大帧上会抛 C++ 异常，emscripten 默认 `-fno-exceptions` 会让它 trap 成 JS 数字异常（`解码失败: 638680`）→ fast 后端崩 → 「扫不出来」。开异常支持 + 大栈让 `catch(...)` 优雅跳过坏帧。② **COMPAT（回退）**：`zxing-wasm/reader` 的 `readBarcodesFromImageData`（RGBA）。**自动探测**：worker `init` 先 `loadFastBackend()`，成功 `ready{fast:true}`（main 喂 Y），失败回退 zxing-wasm `ready{fast:false}`（main 喂 RGBA）。**默认全帧解码**（`maxNumberOfSymbols:4`，码任意位置可检出）。**算法提速**：① `tryInvert:false`；② 两级 tryHarder。decode 可选 `roiGrid`（`{cols:2,rows:2}`）保留代码但**默认不启用**——固定 ROI 把真实拍摄偏移/倾斜的码切半导致难扫，故主链路走全图；`cropRgba` 仅在显式 `roiGrid` 时用。**⚠️ 无自适应 ROI 跟踪**：曾参考 Android `decodeYRegionTracked` 实现 ROI 跟踪，但 Android 实测 ROI 不可靠已回退，Web 同理走全图最稳。**ReceivePage 持 `QR_WORKER_POOL=4` 个 qr worker 池**：captureLoop 每帧派发给第一个空闲 worker（`qrBusyRef`），无空闲才丢帧——多帧跨核并行解码，镜像 Android 线程池；每个 worker 独立 zxing WASM 实例，`decoded` 后标记空闲并把 payloads 喂给单例 receive worker（ingest 仍串行）。**⚠️ 捕获循环用 `scanningActiveRef` 守卫**：`teardown`/`reset` 置 false，`startScanning` 置 true，captureLoop 开头检查——否则上次会话残留的 RVFC/rAF 回调不停止（`requestVideoFrameCallback` 的 handle 无法用 `cancelAnimationFrame` 取消），再点「开始接收」会**双循环重叠**，表现为「第二次很难扫出来」。**FAST 后端的 CI 接入**：`pages.yml` 在 web 构建前跑 `mymindstorm/setup-emsdk@v14`（Emscripten 3.1.64）+ `scripts/build-fastzxing.sh` 生成 `apps/sender/src/fastzxing/airferry_zxing.{js,wasm}`（git-ignored），`prepare-wasm.cjs` 再拷到 `apps/web/public/`；worker 用 `new URL("../airferry_zxing.js", self.location.href)`（与 zxing_reader.wasm 同机制）加载。**生产 web 接收端经 CI 构建后默认启用 FAST**；本地未跑 build-fastzxing 或扩展发送端构建无此产物时，worker `loadFastBackend` 失败回退 zxing-wasm（接收端仍可用，只是慢） |

### 3.3 Android 扫码端

| 关注点 | 位置 | 说明 |
|--------|------|------|
| Activity / 管线编排 | `app/.../ui/ScanActivity.kt:61` | owns 管线、相机绑定、摄入线程；`onCreate` 设 `FLAG_KEEP_SCREEN_ON` 防长传息屏；`onDestroy` 的 native 清理跑在 daemon 后台线程（镜像 Windows 2s quarantine，避免大文件分段 recover 时主线程 `awaitTermination(30s)` ANR） |
| CameraX 生产者（非阻塞） | `app/.../scan/QrStreamAnalyzer.kt:16` | 拷贝 Y 平面入队后立即 close |
| **并行解码 + 串行摄入** | `app/.../scan/QrDecodePool.kt:27` | N worker(2-6) + `ingestLock` 串行化 |
| **v1.1.3 解码调度** | `app/.../scan/QrDecodePool.kt`（`decodeMultiTracked`） | 1.1.4 重新发布版按用户实测回退并锁定为 v1.1.3 的 worker/批摄入/全帧与 ROI 状态机；Windows C# 镜像相同模式。**全帧/ROI 重锁语义**：`multiMiss % MULTI_FULL_DECODE_EVERY == 0`——因 `multiMiss` 初值为 0 且成功后归 0，`0 % 3 == 0` 恒真，**效果是稳定成功时每帧都走 1080p 全帧 `decodeMultiY`，ROI 热路径几乎不可达**。这在理论上是"bug"（注释意图是仅 miss 时全帧），但 **release 实测表明全帧每帧的解码成功率优于 ROI 优先**（曾尝试加 `> 0` 守卫让稳定态走 ROI，A/B 对比实测更难扫），因此**有意保留现状，不要修改此判定条件**。详见 §5 第 9 条 |
| **Rust JNI 桥（Kotlin）** | `app/.../nativelib/NativeBridge.kt` | `receiverIngest` 返回 Long |
| **接收会话管理器** | `app/.../scan/ReceiverSessionManager.kt:17` | 仅从描述符初始化；`IngestStatus.unpack`(line 68) |
| 帧头解析（Kotlin 侧） | `app/.../scan/ReceiverSessionManager.kt:99` | `parseHeader`：60B 大端 |
| ZXing JNI 桥（Kotlin） | `app/.../scan/ZxingDecoder.kt` | 单码/多码/ROI 解码 |
| **ZXing-C++ JNI（native）** | `app/src/main/cpp/scan_jni.cpp` | 完整保留 v1.1.3 解码实现（TryHarder/TryInvert、全帧/ROI/多码打包）；CMake 仍把 ZXing v3.0.2 固定到不可变 commit |
| 多文件包解包 | `app/.../scan/BundleParser.kt` | 恢复后拆包（ETBUNDL1） |
| **文字载荷解析** | `app/.../scan/TextParser.kt` | `isText`/`parse`（ETTEXTv1 → UTF-8）；字节级镜像 TS `text.ts` 与 C# `TextParser.cs` |
| **文本类启发式** | `app/.../scan/TextLike.kt` | **仅 `txt`/`md` 两个扩展名**走文字页（与 Windows `FileNameUtil.TextLikeExtensions` 镜像；曾含 json/html/源码等几十种，v1.2.4 起收紧——其余格式一律按文件处理）；内联文字 UI 上限 `MAX_TEXT_UI_BYTES`=`MaxTextUiBytes`=**256 KiB**（三端镜像含 web `parse.ts`；曾为 8 MiB，多 MB HTML 在文字页主线程整读+整渲染必崩，超限同样走文件页）；`decodeUtf8Strict` 拒绝非 UTF-8。**ETTEXTv1 超限/非法 UTF-8 的落盘必须先剥 8 字节 magic**（`TextParser.payloadWithoutMagic`，Windows `bytes[TextParser.Magic.Length..]`，web `subarray(TEXT_MAGIC.length)`）——曾把含协议头的原始字节直接存成文件（P1 已修，四处入口：两平台 recoverAndStage/ArchiveSegmentedTransfer + web parse） |
| **内容库（映射去重）** | `app/.../scan/ContentStore.kt` | `files/store/blobs/<hh>/<sha256>` + `index.json`。大文件新任务/逐段写入先检查空间；完成时验证根 SHA，成品同卷原子移动到内容地址，并以根任务派生的稳定条目 ID 做崩溃重试，既不重复历史记录也不产生常态 2× 占用。Windows 实现同构 |
| **分段账本（磁盘 .partial + bitmap）** | `app/.../scan/SegmentAssembler.kt` | `storeSegment` 随机写 `.partial` + 原子 `bitmap.json`；`open()` 恢复时对每个标记段做全量 SHA-256 复核，**修正结果即时 best-effort 落盘**——防「账本虚报完备」（bitmap 计满但某段 `.partial` 损坏）让廉价账本检查（`listTasks`/重归档门）反复误判完备、每个 descriptor 帧触发一次逐段全量重哈希的自旋；`hasStoredSegment` 是只读单段复核快路径 |
| 文件导出名 / MIME | `app/.../scan/FileTransfer.kt` + `AirFerryFileProvider.kt` | ContentStore 实体是无扩展名 SHA-256；四参数 URI 把逻辑名写入 `DISPLAY_NAME`，自定义 provider 覆盖 `getType`/`getTypeAnonymous` 返回逻辑 MIME；SAF 同样按扩展名选择 MIME，避免目标应用落成 `.bin` |
| UI | `app/.../ui/{ReceiveDetail,ReceiveText,ReceiveBundle,FileList,Settings}Activity.kt` | 详情/文字/列表/设置。`recoverAndStage` 写入 ContentStore；Android 分享直出 blob，但 URI 携带逻辑文件名和 MIME。FileList 后台完成回调（清空/删除）带 `isDestroyed` 守卫且 `refresh()` fail-safe（生命周期检查 + executor 已关时静默跳过）——防 onDestroy 后回调触发 `RejectedExecutionException` 主线程崩溃 |
| **文字接收页（可复制/分享/存 .txt）** | `app/.../ui/ReceiveTextActivity.kt` | ETTEXTv1 或文本类；历史列表按 entry.kind / TextLike 打开 |

### 3.4 Windows 扫码端

| 关注点 | 位置 | 说明 |
|--------|------|------|
| **Rust C ABI 桥（P/Invoke）** | `apps/windows/AirFerry.Windows/Native/NativeBridge.cs` | 27 个 `[DllImport]` 声明（另 `NativeZxingBridge.cs` 有 3 个），对标 Android `NativeBridge.kt`。⚠️ 每个**必须钉死 `EntryPoint = "airferry_*"`**：Rust `cffi.rs` 导出 snake_case 符号，而 P/Invoke 默认按 C# 方法名（PascalCase）查找——漏写会让首个 native 调用抛 `EntryPointNotFoundException`，且 CI 协议层单测（纯 C# 逻辑，不触达 DLL）无法发现。对比 JNI 由 JVM 自动解析 `Java_<class>_<method>` 名，Windows 走纯 C ABI 无此机制。**路径参数用 UTF-8 `byte[]` + `Encoding.UTF8.GetBytes(s+"\0")`**（`DecompressStreamToFile`），不能用 `[MarshalAs(LPStr)] string`（ANSI 会破坏非 ASCII 路径，见 §5） |
| **接收会话管理器** | `apps/windows/AirFerry.Windows/Scan/ReceiverSession.cs` | lazy init from descriptor + mismatch re-init（镜像 Kotlin） |
| 帧头解析 | `apps/windows/AirFerry.Windows/Scan/FrameHeader.cs` | 60B 大端，magic/version/session_id hi+lo |
| IngestStatus 位域解析 | `apps/windows/AirFerry.Windows/Scan/IngestStatus.cs` | `.Unpack(u64)`，位布局与 Rust/Kotlin 一致 |
| **v1.1.3 模式 + 串行摄入** | `apps/windows/AirFerry.Windows/Scan/QrDecodePool.cs` | 镜像 Android v1.1.3：N worker（2–6）、容量 `worker+2`、4 符号批摄入、相同全帧/ROI 状态机（`% 3 == 0` 使稳定成功时每帧全帧，有意保留——实测优于 ROI 优先，见 §5 第 9 条）；额外保留池化 Gray 与安全停止 |
| ★**扫描来源枚举（摄像头+采集卡+屏幕）** | `apps/windows/AirFerry.Windows/Scan/DeviceEnumerator.cs` + `Models/ScanSourceOption.cs` | DirectShow `DsDevice` 统一枚举摄像头/采集卡，再由 `ScanSourceOption.Build` 追加唯一的屏幕捕获 sentinel；DeviceSelectView 以单选列表消费，硬件选项直接生成 `DeviceSource`，屏幕选项必须先走 RegionPicker |
| **视频源抽象** | `apps/windows/AirFerry.Windows/Models/ScanSource.cs` + `Scan/IFrameSource.cs` + `Scan/FrameSourceFactory.cs` | `ScanSource` record（`DeviceSource`/`ScreenRegionSource`/`WindowSource`）从设备选择页贯穿到 `ScanViewModel.StartScan(ScanSource)`（取代旧 `int deviceIndex`）；`IFrameSource` 是拉模式帧源契约（`IsOpen`/`ReadGray()→CV_8UC1`/`SnapshotBgr()→PreviewFrame`/`Dispose`），`ProducerLoop` 对源类型无其他假设；工厂按源类型分派构造 |
| 视频采集 + 预览（设备） | `apps/windows/AirFerry.Windows/Scan/VideoCapture.cs` + `PreviewFrame.cs` + `PreviewFrameCopy.cs` | 实现 `IFrameSource`。单个 OpenCvSharp DirectShow 句柄：生产线程一次读取后 BGR→Gray 送解码池，并以 15fps 将池化 BGR24 快照交给 WPF；UI 线程不读设备，快照由消费端 `Dispose` 归还 `ArrayPool`。Mat→PreviewFrame 拷贝抽到 `PreviewFrameCopy.FromBgr`（**不放 `PreviewFrame.cs`**——该文件被纯 net8.0 测试项目链接，不能引 OpenCvSharp）。**拔出/无信号检测**：DirectShow `IsOpened()` 在设备拔出后仍返回 true（`Read` 恒 false），故持续 5s 无好帧即置 `_lost` 令 `IsOpen=false` → `ProducerLoop` 报「视频源已关闭」；用时间窗而非 ScreenCapture 的 30 帧计数，防采集卡 HDMI 信号晚到几秒被误杀 |
| ★**屏幕区域/窗口捕获（GDI）** | `apps/windows/AirFerry.Windows/Scan/ScreenCapture.cs` + `Scan/Native/ScreenNative.cs` | 实现 `IFrameSource`，零新增 NuGet 依赖。区域=每帧 `BitBlt`（GetDC(NULL) 虚拟屏幕坐标，PerMonitorV2 下即物理像素）；窗口=`PrintWindow(PW_RENDERFULLCONTENT)` 优先（被遮挡多数应用仍可捕获）失败回退 `BitBlt`（需窗口可见）。`GetDIBits`（biHeight 负=top-down）直写复用 BGRA Mat → `BGRA2GRAY` 一步到灰度；GDI 无阻塞，内部按 60fps Stopwatch 节流防 CPU 空转；窗口销毁/连续 30 帧失败→`IsOpen=false`，`ProducerLoop` 检测后经 `HandleFrameSourceLost` 以 `Task.Run` 停止（**不能在 producer 线程同步调 `StopScan`——会自 join 死锁**）。⚠️ MSDN 规定 `GetDIBits` 运行时 bitmap 不得选入 DC：用 `_stockBitmap` 换入换出；Dispose 删 bitmap 前同样先反选。`Scan/ScreenRectUtil.cs` 是纯几何逻辑（可跨平台单测） |
| ★**截图式源选择器** | `apps/windows/AirFerry.Windows/Views/RegionPicker.cs` + `RegionPickerWindow.xaml(.cs)` | DeviceSelectView 把「屏幕捕获」与摄像头/采集卡放进同一个 `ListBox` 做互斥单选，底部统一 `StartScan_Click` 入口；只有选中屏幕捕获再点主按钮才打开选择器，取消后仍停留在来源页，不再保留可误触的独立屏幕捕获按钮。选择器每显示器一个全屏半透明覆盖窗（`EnumDisplayMonitors` 物理矩形 + `SetWindowPos` 钉位，各自 `PixelsPerDip` 做 DIP↔物理换算，混合 DPI 多屏各自正确）；拖动=区域（≥32×32），单击=选窗口（<6px 位移算 click），**右键=选整个屏幕**（`OnRightUp` 直接以本覆盖窗的显示器矩形完成——全屏应用/游戏首选路径：无边框游戏会因覆盖层抢焦点而最小化、独占全屏窗口既高亮不到也 `PrintWindow` 不到，整屏区域捕获可绕开两者），Esc 取消；覆盖层是**输入屏障**——其**前置条件是 `Window.Background="#01000000"`（alpha=1/255）而非 `Transparent`**：`AllowsTransparency` 分层窗按像素 alpha 做 **OS 级**命中测试，挖洞区（变暗 Border 未覆盖的悬停/选框内部）若为 alpha=0 会在 OS 层直接穿透给下层应用（表现为：悬停高亮正常但洞内左右键触发应用自身——事件根本不进 WPF，`e.Handled`/延迟关闭均无效，勿误判为事件处理器问题）；右键走独立 Preview 事件，**中键/X 键走通用 `PreviewMouseDown/Up` 按 `ChangedButton` 判定**（⚠️ WPF 没有独立的中键/X 键 Preview 事件，`PreviewMouseMiddleButtonDown` 等成员不存在，写了即编译错），滚轮 `PreviewMouseWheel` 吞掉，只有左键参与选择，防任何输入漏到下层应用；**输入坐标一律 `GetCursorPos` 全局物理坐标**（`CursorPhysical()`，勿改回 `e.GetPosition(this)`+DIP 换算——拖拽经鼠标捕获合法跨屏/跨 DPI，窗口本地 DIP 外推正是跨屏拖框坏掉的根因），渲染锚点为窗口实际矩形回读（`SyncOrigin`，Loaded/OnDpiChanged 重锚）；共享 `RegionPickerSession` + `TaskCompletionSource` 返回 `ScanSource?`，**完成选择后覆盖层延迟关闭以吞掉双击习惯的尾随第二击**（`TryComplete` 用 DispatcherTimer，间隔=**`GetDoubleClickTime()`+50ms**——系统双击窗口用户可调、默认 500ms，固定 300ms 拦不住；勿改回固定值），否则第二击会穿透进刚选中的应用（浏览器里表现为「点了文字」）。⚠️ **不能用 `WindowFromPoint` 找目标窗口**——覆盖层自身 Topmost 且可命中，永远返回自己；用 `EnumWindows` 按 Z 序扫第一个「非本进程/可见/非工具窗/非 cloaked/≥64px 且含光标」的窗口。`PickAsync` 是**非 async 的 TCS 方法**：覆盖窗创建/`Show()` 中途抛异常时先 `TryComplete(null)` 关闭已显示窗口再**重抛**（同步异常发生在 Task 返回前，调用方 `StartScan_Click` 是 async void——无兜底即崩进程；现整段 try/catch + `UiMessages.ErrorAsync` 兜底） |
| **Windows ZXing-C++ C ABI** | `apps/windows/native/` + `core/zxing-decoder/` | Windows 薄导出层；全帧与 ROI 都使用 Android v1.1.3 相同的 TryHarder/TryInvert，固定 ABI 版本和 packed 结果布局 |
| QR 结果解析 | `apps/windows/AirFerry.Windows/Scan/ZxingDecoder.cs` + `Native/NativeZxingBridge.cs` | P/Invoke 调用 `airferry_zxing.dll`，校验长度/上限并在 finally 释放 native buffer |
| 多文件包解包 | `apps/windows/AirFerry.Windows/Bundle/BundleParser.cs` | ETBUNDL1（字节级镜像 Kotlin BundleParser.kt） |
| 分享导出 | `apps/windows/AirFerry.Windows/Bundle/ShareExport.cs` | 不暴露无扩展名 hash blob；生成带逻辑名的临时副本、写 MOTW，并在启动/下次分享时清理超过 24 小时的受控 GUID 目录 |
| **文字载荷解析** | `apps/windows/AirFerry.Windows/Bundle/TextParser.cs` | `IsText`/`Parse`（ETTEXTv1 → UTF-8）；字节级镜像 TS `text.ts` 与 Kotlin `TextParser.kt`。有跨平台单测 `TextParserTests.cs` |
| 文件名 sanitize | `apps/windows/AirFerry.Windows/Bundle/FileNameUtil.cs` | + Windows 保留名（CON/PRN/COM1-9）处理 |
| 主状态机 | `apps/windows/AirFerry.Windows/ViewModels/ScanViewModel.cs` | 编排单源采集→解码池/预览→会话→恢复→落盘；7Hz UI 快照展示 3 秒窗口解码/有效吞吐和源/传输大小。停止以 session epoch 作废旧 UI 回调；前台最多等 2 秒，超时则保留资源并由单一后台任务按 producer→recovery→workers→native/camera 顺序安全释放，完成前禁止重启；`RecoverAndStage` 按 text→bundle→单文件顺序分流（分类级联统一在共享 `ClassifyRecovered`，普通/分段两路共用防漂移）。**descriptor-v5 分段（压缩后分段）**：`RecoverAndStageCore` 开头检测 `session.IsSegmented()` → `HandleSegmentedTransfer` 用 `session.AssembleRaw()` 取本段压缩字节存入 `Bundle/SegmentAssembler`，未到齐返回 None（保持扫描，显示「k/N 段已收」），全部到齐 `Finish()` 拼接压缩流→native 解压一次→校验长度+CRC32+根 SHA-256，再分流落盘。**已完成分段回放过滤**：段存档成功后 `SwapReceiverForNextSegment(rememberCompleted: true)` 把该子会话 id 记入 `Scan/CompletedSegmentTracker`，`OnDecoded` 在 `session.Ingest` 前丢弃该会话的后续帧——否则发送端仍停留在上一段期间，新会话会重新初始化到已收段（进度归零、下一段永远初始化不了，issue #8）。tracker 只匹配合法 AirFerry 帧头（magic/version），屏幕上的环境二维码不会误伤；`StartScan` 清空 |
| ★**持续接收模式** | `ScanViewModel`（`SetContinuousDir`/`DisableContinuous`/`RecordContinuousOutcome`/`ContinueNextTransfer`）+ `Bundle/ContinuousSave.cs` + `ScanView` 持续接收卡 + `AppSettings` `continuous_dir` | ScanView「持续接收」开关（`OpenFolderDialog` 选目录、随时「更改」，AppSettings 记忆上次目录）。开启后完成时**不导航不停扫**：`ClassifyRecovered` 四态分类 → `ContinuousSaver` 直写目标文件夹（**不进 ContentStore**，大文件磁盘不双份、历史列表只含手动接收）→ `SwapReceiverForNextSegment` 重臂接收下一份（与分段传输段间换会话同一原语，管线不重启）。**去重**=内容 SHA-256 且**跳过前必复验文件夹实际字节**（记录指向的文件/包成员被删除或篡改即判定失效，重放按新保存恢复，不吞掉缺失文件）：会话内 digest→已存路径记录 + 目标文件夹同名同大小同哈希跳过（跨重启不产生副本），同名不同内容走 `UniqueTarget` 加 (N)；bundle 按成员名+内容摘要**整包判重**、存独立子文件夹 `发送_MMdd_HHmmss`（**跨重启**：每个包目录内写 `.airferry-bundle-id` 标记 = 整包摘要 + 每成员最终名/大小/SHA-256 清单，新 saver 保存前扫描既有包目录标记并**逐一复验成员实际字节**后才跳过——真值随数据走，删目录即删去重记录；成员被删/改则标记失效，重放存全新副本）（**事务性**：成员先写隐藏 `.tmp` 暂存目录、全部成功后一次 `Directory.Move` 改名，中途失败清暂存整体抛错不留半成品；成员清洗后重名（如 `a:b.txt`/`a*b.txt`→`a_b.txt`）自动加 (N) 不互相覆盖）；>256MiB 分段走 `MoveVerifiedFile`——**不用跨盘 `File.Move`**（Documents→U 盘等异盘场景 Move 的 copy+delete 中途失败会丢文件）：先复制到目标盘 `.tmp`、flush、复验 SHA-256、原子改名、成功后才删源。**保存失败（目录被删/磁盘满/跨盘校验失败）不中断扫描**，且分段归档路径**失败时绝不 `CommitArchived`**——保留分段账本+解压产物+恢复记录，同一流重播或历史页「继续恢复」走幂等归档重试。**模式与 saver 实例在完成检测时刻快照**（`OnDecoded` dispatcher 处捕获传入 `RecoverAndStageAsync`→`RecoverAndStageCore`→`HandleSegmentedTransfer`→`ArchiveSegmentedTransfer` 全链穿透），中途换目录的在途文件仍落旧目录；`RecordContinuousOutcome` 仅当快照 saver 仍是当前 saver 时才计数/进列表（状态行带旧目录名提示），新目录计数不被旧传输污染。同目录关闭再开启保留去重集。单测 `ContinuousSaverTests.cs`（跨平台 net8.0） |
| ★**窗口壳 + 主题系统（WPF-UI Fluent）** | `apps/windows/AirFerry.Windows/Views/MainWindow.xaml(.cs)` + `Services/ThemeService.cs` + `Services/AppSettings.cs` + `Themes/DesignTokens.{Light,Dark}.xaml` | UI 基于 lepo.co **WPF-UI 4.3.0**（csproj PackageReference；net8.0-windows 兼容、Win10 可用，`WindowBackdropType=None` 不用 Mica）。**应用图标**：`Assets/app.ico`（16–128 五档，由接收端图标 `apps/sender/assets/receiver-icon*.png` 生成：`magick ../../sender/assets/receiver-icon{16,32,48,64,128}.png Assets/app.ico`），csproj `<ApplicationIcon>` 钉进 exe（任务栏/Alt-Tab/资源管理器），Window `Icon` + 标题栏 `ctrl:ImageIcon`（**自写控件 `Controls/ImageIcon.cs`**——WPF-UI 4.3.0 没有 ImageIcon，TitleBar 模板也不会回退显示 Window.Icon，只认自己的 `IconElement` 子类）。`MainWindow` 是 `ui:FluentWindow`，内容 Grid 首行放 `ui:TitleBar`、第二行放内嵌 `Frame`（`NavigationUIVisibility=Hidden`、`JournalOwnership=OwnsJournal`）——**4.x 没有 `FluentWindow.TitleBar` 属性元素写法**（实测编译失败；`TitleBarProperty` 字节在 DLL 里但属别的类），TitleBar 必须是窗口内容的第一个子元素。Frame 取代旧的「StartupUri→Page 隐式 NavigationWindow」；7 个 Page 共 17 处 `NavigationService?.Navigate/GoBack` 调用点形态不变（`Page.NavigationService` 指向 Frame；设备启动一处 `ScanView` 构造参数 `int deviceIndex`→`ScanSource`、屏幕捕获入口新增一处）。主题：`App.xaml` 合并 `ui:ThemesDictionary`(初始 Light) + `ui:ControlsDictionary` + 自有语义 token 字典（`SuccessBrush`/`ErrorBrush`/`WarningBrush`/`PreviewBackdropBrush`，浅/深两套值）；`ThemeService.ApplyPreference(pref, window)` 按 `settings.json` 的 `theme` 字段（`light`/`dark`/`system`，默认 system）切主题——system 模式用 `SystemThemeWatcher.Watch/UnWatch` 接收 OS 切换通知，但**浅/深判定不信任库**（`OnLibraryThemeApplied` 按 `AppsUseLightTheme` 注册表纠正：WPF-UI 4.3.0 的 `SystemThemeManager` 先匹配主题**文件名** `Themes\CurrentTheme`（如 dark.theme）再回退 `AppsUseLightTheme`，Windows 从深色切回浅色常不把文件名改回 aero.theme → 库在浅色系统上应用 Dark，曾致 App 默认深色）；并订阅 `ApplicationThemeManager.Changed`（幂等：取当前主题重放）使**每次**主题应用——含 system 模式下 OS 切换——都重放 `ApplicationAccentColorManager.Apply(#2563EB, effectiveTheme)` 品牌主色并替换 DesignTokens 字典 Source（否则 OS 切换只换 WPF-UI 字典，自有语义色滞留旧主题）。**主题相关画刷引用必须用 `DynamicResource`**（主题切换换字典，StaticResource 不更新）。设置持久化由 `AppSettings` 独占读写（手写极简 JSON，跨端格式对齐，加字段勿改格式；`SetRedundancy`/`SetTheme` 整文件重写防丢键） |
| **主题化弹窗** | `apps/windows/AirFerry.Windows/Services/UiMessages.cs` | 全部弹窗走 `ui:MessageBox`（`InfoAsync`/`ErrorAsync`/`ConfirmAsync`），不用 `System.Windows.MessageBox`（不认主题）。⚠️ **必须 `await`**：`ShowDialogAsync` 自建模态循环，dispatcher 上 `.GetAwaiter().GetResult()` 会死锁；`IsCloseButtonEnabled=false` 会折叠 Close 按钮列（单按钮信息框观感） |
| UI | `apps/windows/AirFerry.Windows/Views/*.xaml` | Scan/DeviceSelect/ReceiveDetail/ReceiveText/ReceiveBundle/FileList/Settings；历史任务显示缺失段范围，“继续恢复”把 root id 经 DeviceSelect/ScanView 传入 ScanViewModel，非目标传输会被忽略；Scan 的安全停止等待移出 Dispatcher。DeviceSelect 首页头部含「接收文件」入口（直达 FileListView，不必先进扫码页），摄像头/采集卡/屏幕捕获统一为互斥的扫描来源单选项并共用一个主按钮；三个接收页（Detail/Text/Bundle）左上角均有「返回」（`Back_Click`→`GoBack`）；接收完成后的「保存」成功状态**内联显示在按钮上**（置为「已保存 ✓」并禁用），不再弹模态对话框。视觉规范：页面底 `{DynamicResource ApplicationBackgroundBrush}`、卡片 `ui:Card`（**Card 继承 ContentControl 无 Padding 属性**，内边距写在子元素 Margin 上；需填满行高时显式 `VerticalAlignment="Stretch"`，其默认样式不拉伸）、按钮 `ui:Button`（Appearance=Primary/Secondary/Transparent；**图标必须显式 `<ui:Button.Icon><ui:SymbolIcon Symbol="Xxx24"/></ui:Button.Icon>`——`Icon="Xxx24"` 字符串简写实测不渲染**；要铺满宽度须显式 `HorizontalAlignment="Stretch"`，WPF-UI Button 样式默认左对齐缩到内容宽）、状态提示 `ui:InfoBar`（Severity=Success/Error/Informational 取代硬编码绿红 TextBlock）、图标 `ui:SymbolIcon`（Segoe Fluent Icons，`SymbolRegular` 枚举）。**`ui:ComboBox`/`ui:Slider` 类不存在**——WPF-UI 靠 ControlsDictionary 的隐式样式美化标准 `ComboBox`/`Slider`，直接用无 `ui:` 前缀的标准控件。ScanView 进度环仍是代码绘制（叠加半透明黑底 + 白色百分比，保证深浅主题下在摄像头画面上都可读），进度弧画刷走 `FindResource("AccentFillColorDefaultBrush")`。设置页含「外观」选项（跟随系统/浅色/深色，即改即存即生效） |
| **文字接收页（可复制/保存 .txt）** | `apps/windows/AirFerry.Windows/Views/ReceiveTextView.xaml` | `Clipboard.SetText` + SaveFileDialog UTF-8；RecoveryResult 新增 `Text`/`IsText` |

> 接收结果页 UI 约定：Detail/Text/Bundle 的「返回」独占首行，成功图标与完成提示放下一行；单文件/文件包页调用 Explorer 的按钮文案为「打开文件夹」（内部仍用 `ShareExport` 为 ContentStore blob 生成带逻辑文件名的临时导出）。

### 3.5 网页发送端

> **功能与浏览器扩展（§3.2）完全一致**，**直接复用 `apps/sender/src/` 全部源码，无代码重复**。下表只列 web 端特有的接入点；业务逻辑（页面/组件/worker/wasm）见 §3.2。

| 关注点 | 位置 | 说明 |
|--------|------|------|
| 薄入口（mount sender App） | `apps/web/src/{main,receiver,standalone}.tsx` | web 专有源文件共三个：`main.tsx`（发送端入口，`import App from "@/options"` + `createRoot().render(<App/>)`）/ `receiver.tsx`（接收端入口，mount `@/pages/ReceivePage`）/ `standalone.tsx`（单文件入口，mount 前设 `__AIRFERRY_STANDALONE__=true`）。业务逻辑全部复用 sender |
| Vite 配置（跨工程 alias） | `apps/web/vite.config.ts` | `resolve.alias: { "@/": "../sender/src/" }` —— sender 源码内部所有 `@/` 引用全部重定向到真实文件；worker 的 `new URL("./workers/...", import.meta.url)` 跨工程解析 |
| WASM 前置校验 + zstd 拷贝 | `apps/web/scripts/prepare-wasm.cjs` | `predev`/`prebuild`/`prebuild:standalone` 跑：①持锁校验 sender `wasm-pkg-simd` 并原子复制到 web 私有 `wasm-pkg/`；②拷 zstd WASM 到 `public/` |
| lzma-wasm 提取 | `apps/web/scripts/extract-lzma-wasm.cjs` | 同 sender 版（base64 → 物理 .wasm，解 Rollup 静态分析）。`postinstall` 跑 |
| **环境自适应接入点** | `apps/sender/src/options.tsx` | 三环境共用同一份源码，按运行环境分流：① 扩展（`chrome.runtime.getURL`）② 网页普通版（`document.baseURI` fetch）③ **单文件版**（`globalThis.__AIRFERRY_STANDALONE__` 标志 → Blob URL worker + base64 WASM）。**zstd 预加载做三路判断**（standalone base64 / 扩展 getURL / 网页 baseURI）；**worker 初始化只两路**（standalone Blob URL / 否则 `new Worker(new URL(...))`，扩展与网页普通版走同一 module Worker 路径，无需 getURL/baseURI 分流）。扩展/普通版行为不变 |
| **base64 工具（单文件专用）** | `apps/sender/src/wasm/base64.ts` | `base64ToBuffer(b64)`：`atob` + Uint8Array，主线程/worker 共用。单文件版运行时把内联 base64 WASM 解码成 buffer，喂给 `init(buffer)`/`initZstdFromBytes` |
| 相对路径部署 | `apps/web/vite.config.ts` `base:"./"` | 产物 `dist/` 资源用 `./assets/...`，可部署到任意子路径（GitHub Pages 的 `user.github.io/repo/` 等） |
| **单文件构建配置** | `apps/web/vite.standalone.config.ts` + `apps/web/src/standalone.tsx` | IIFE bundle + worker 单独 ES chunk。`standalone.tsx` mount 前设 `__AIRFERRY_STANDALONE__=true` 触发单文件路径 |
| **单文件后处理** | `apps/web/scripts/build-standalone.cjs` | 把 Vite 多文件产物内联成单个 `dist-standalone/index.html`：注入 worker 源码（`__WORKER_CODE__`）+ zstd base64（`__WASM_ZSTD__`）+ process polyfill；处理 `</script>` 转义 + `import.meta.url` 替换 |
| **接收端单文件配置/入口** | `apps/web/vite.receiver-standalone.config.ts` + `apps/web/src/receiver-standalone.tsx` | IIFE 主 bundle + 两个 Worker chunk；入口 mount 前设 `__AIRFERRY_STANDALONE__`；`worker.rollupOptions.output.inlineDynamicImports` 保证每个 Worker 自包含 |
| **接收端单文件后处理** | `apps/web/scripts/build-receiver-standalone.cjs` | 把 `dist-receiver-standalone/` 内联成单 HTML：`__RECEIVE_WORKER_CODE__`（含 `__WASM_TRANSFER_ENGINE__` base64）、`__QR_WORKER_CODE__`（含 FAST JS/wasm + `zxing_reader.wasm` base64）、`__WASM_ZSTD__`；断言 Worker chunk 无静态 import，处理 `</script>` 转义并清理中间产物 |

---

## 4. 调试速查表（症状 → 首查位置）

| 症状 | 首查 | 可能原因 |
|------|------|---------|
| 点扩展图标仍弹小窗（而非直跳 options） | `apps/sender/src/background/index.ts` + `fix-manifest.cjs` | manifest 残留 `default_popup`（popup 优先级高于 `onClicked`）；或 `src/popup.tsx` 误被恢复（Plasmo 据此重新注入 popup）。删 popup.tsx + `fix-manifest.cjs` 兜底删 `default_popup` 是触发 `onClicked` 的前提 |
| 文字传输收端当文件保存 | `TextParser` + `TextLike`/`IsTextLikeName` + `options.onSend` | 仅「列表里只有 1 条 text」才 ETTEXTv1。混发文字是 `.txt` 条目——点开仍可进 `ReceiveText`（扩展名启发式）。非法 UTF-8 的「文本扩展名」回退文件页。若单条文字也落成文件，查是否误走了 `itemsToFiles` |
| 发送文字时自定义文件名不生效 | `options.onSend` + `compress.worker processText` + Android/Windows ETTEXTv1 落盘 | 纯文字须 `postMessage({ text, name })`，worker 用 name 作 `displayName`/session；收端 ETTEXTv1 用描述符 `fileName()`，勿写死 `文字消息.txt` |
| 拖文件就跳进参数页 | `FileSelectPage` + `options.onSend` | 选择只改 pending `items`；必须点「发送」才 stage。若又变成选完即跳，检查是否误把 `onItemsChange` 接回了立即压缩 |
| 收端卡「恢复中 0%」 | `descriptor::parse_payload` + `ReceiverSession::ingest` | OTI 未确认（`meta_confirmed=false`）；描述符解析失败 |
| 收端崩溃（扫码即崩） | `ObjectMeta::validate` + receiver 摄入守卫 | 恶意/越界坐标未在入解码器前拦截（panic=abort 下致命） |
| 进度越往后越慢 | `sender::next_symbol_id` | 必须是「源一遍→持续新鲜修复」，不能循环有限计划；ESI 达协议上限时返回错误 |
| 帧被静默丢弃 | `Frame::from_bytes` | magic/version/双层 CRC 校验失败 |
| 恢复出空文件 | `descriptor` v2/v3 消歧 + `compressed_size_known` | v3 尾部被误读为 v2 补零 |
| 解压 OOM / 崩溃 | `compress.rs:106 decompress_with_limit` | 炸弹上限未封顶到 `original_size` |
| JNI 摄入竞态/UAF | `QrDecodePool.ingestLock` + `ScanActivity` `ingestStopped` | 句柄非线程安全，未串行化 |
| 摄像头读不出码 | `qr_render::encode`（版本选择）+ `scan_jni` TryHarder | 版本过高致模块过密；或 16KiB 页未对齐致 .so 加载失败 |
| 长时间扫码后息屏/锁屏 | `ScanActivity.onCreate` `FLAG_KEEP_SCREEN_ON` | 扫码页必须 `window.addFlags(FLAG_KEEP_SCREEN_ON)`；仅窗口可见时生效，离开 Activity 自动恢复系统超时 |
| 解码速率/用时速度不“即时” | `ScanActivity` `rateSamples` / `RATE_WINDOW_MS` | 应用 ~3s 滑动窗口 `Δ符号/Δt`（及 `×symbolSize`），勿再用全程 `wireBytes/elapsed` 平均；完成时清零 |
| 压缩总是走 raw（100%） | `compress.ts` `initZstdFromBytes` | worker 内 zstd WASM 未加载成功（主线程应仍 post `wasm-init`；缺 zstd 时允许 raw，不应卡死） |
| 点发送后永久「正在准备」 | `compress.worker` `ready` + `options` `wasm-init` | 主线程未 post `wasm-init`（含失败时 `zstd: null`）；或 worker 仍硬等 zstd 成功才 ready |
| **网页端压缩走 raw（100%）** | `apps/web/public/wasm-zstd.wasm` + `prepare-wasm.cjs` | `public/wasm-zstd.wasm` 缺失（未跑 `prebuild`），worker fetch 404 → 回退 raw。重新跑 `npm run build`（会触发 `prebuild`→prepare-wasm） |
| **网页接收端传输完成时报 `Failed to fetch wasm-zstd.wasm: 404`（小文件不出现）** | `ReceivePage.tsx` 的 `wasm-init` 预加载 + `receive.worker.ts` 的 `initZstdFromBytes` | receive worker 未拿到主线程预加载的 zstd 字节，运行时按 worker 自身 `assets/` URL 相对 fetch → 404（文件在站点根）。raw/小文件不走 zstd 故不触发。确认 `ReceivePage` 在 post `init` 前 `await preloadZstdBytes()` 并发 `wasm-init`（FIFO 保证先于 assemble）；`compress.ts` 兜底 fetch 按环境分流（主线程 `document.baseURI` / worker `../`） |
| **网页接收端单文件版 FAST 解码失败 / 一直回退 compat** | `core/zxing-decoder/link-wasm.sh` + `apps/sender/src/workers/qr-decode.worker.ts` | worker 用 `fastMod.HEAPU8/HEAPU32`，Emscripten 4+ 不再默认把堆视图挂到 Module：`link-wasm.sh` 必须 `EXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAPU32` 且用 `em++` 链接 C++ 异常运行时。standalone 下 `import.meta.url` 是 Blob URL，`findWasmBinary()` 的相对 `new URL()` 会抛 `Invalid URL` → 必须同时传 `wasmBinary` 和 `locateFile`（返回 wasm 的 Blob URL） |
| **网页接收端单文件版双击空白/Worker 初始化失败** | `apps/web/scripts/build-receiver-standalone.cjs` + `ReceivePage.tsx` | Worker chunk 必须无静态 import（post-processor 有断言）；必须用 `new Worker(blobUrl,{type:"module"})`；`transfer_engine`/zstd/FAST/reader WASM 必须全部注入；`file://` 下只支持 Chrome/Edge（Safari/Firefox 未验证）。**用户侧最常见根因是 Edge「设置→隐私→增强安全性模式」禁用 WASM/Blob Worker**——v1.2.9 起接收页在 worker `error` 事件上立即 fail-fast（不再只报 8s 超时），超时文案附该设置路径（issue #15） |
| **网页接收端摄像头报「无法访问摄像头：Could not start video source」** | `ReceivePage.tsx` `describeCameraError` | NotReadableError = 摄像头被其他程序占用（会议/相机软件）或被系统隐私设置禁用（Windows：设置→隐私和安全性→摄像头），**与页面协议无关**——Chromium 的 `file://` 是安全上下文。「HTTPS/localhost」提示只在真正非安全上下文出现；NotAllowedError=权限被拒、NotFoundError=无设备，提示按错误类型细分 |
| **网页接收端扫到环境二维码（URL/支付码等）后永久「接收中 0」/建立不了传输** | `apps/sender/src/receive/sessionGuard.ts` + `receive.worker.ts` relock | 缓存引导探针未验 magic/version → 垃圾 session id 锁死会话；或误引导后 Rust 对所有真帧（含描述符）SessionMismatch 永不恢复。确认探针走 `isCacheBootstrapProbe`（验 magic/version/flag），重锁判定 `!meta_confirmed && !everAccepted && mismatchStreak≥3`（`MISMATCH_RELOCK_THRESHOLD`，带 `jobId===activeJobId` 守卫）能触发 `dropSession()` 重引导；`npm test`（`test-receive-guard.mjs`）覆盖 |
| **网页端启动报 transfer_engine.js 找不到** | `apps/sender/wasm-pkg-simd/` | web 从 sender 现代产物复制自有快照；首次构建前需 `cd apps/sender && npm run wasm`。`prepare-wasm.cjs` 会校验并报清晰错误 |
| **`release`/`dist` 产物缺 web zip** | `apps/web/dist/` | `pack_dist` 用 warn 模式（非中断）：`apps/web/dist/` 缺失时跳过 web zip。先跑 `./scripts/build-all.sh web` 再 `dist`/`release` |
| 扩展构建缺 WASM | `apps/sender/wasm-pkg-legacy/` 或 `wasm-pkg-simd/` | 单独跑 `npm run build:chrome-mv3` 等单目标脚本前忘了先 `npm run wasm`（双产物缺失） |
| APK 缺 native 库 | `jniLibs/arm64-v8a/libtransfer_engine.so` | v1.2.0 起 Gradle `compileRustJni` 已自动前置，正常不会缺；若缺说明编译环境（cargo-ndk / NDK）有问题 |
| 安卓 >32 MiB 一直「正在同步」/ JNI 版本过旧 | `core/transfer-engine/src/jni.rs` `AIRFERRY_NATIVE_ABI_VERSION` + `NativeBridge.nativeAbiVersion()` | APK 内 `.so` 是旧版（缺 v5 分段符号）。v1.2.0 双防护：Gradle 自动重编 + 启动 ABI 握手拒绝旧库。设备上旧 APK 需卸载重装最新版 |
| Windows 端 DllNotFoundException | `apps/windows/AirFerry.Windows/runtime/{transfer_engine,airferry_zxing}.dll` | 手动跑 `dotnet build` 而未经 `build-windows.ps1`；后者会自动构建、测试并复制 Rust 引擎与 ZXing-C++ 两个 DLL |
| Windows 端 EntryPointNotFoundException | `apps/windows/AirFerry.Windows/Native/NativeBridge.cs` | `[DllImport]` 缺 `EntryPoint`：P/Invoke 默认按 PascalCase C# 方法名查找，但 Rust `cffi.rs` 导出的是 snake_case `airferry_*`。**首个 native 调用即抛**（热路径 `ReceiverIngest` → 扫第一个码就崩），CI 协议层单测测不到。修复：每个声明钉死 `EntryPoint = "airferry_receiver_ingest"` 等 |
| Windows 端设备打不开 | `DeviceEnumerator.cs` + `VideoCapture.cs` | 设备被其他程序独占；或 DirectShow 驱动问题（换 MSMF 后端或换设备） |
| **Windows 屏幕捕获黑屏/无帧** | `Scan/ScreenCapture.cs` + `Views/RegionPickerWindow.xaml.cs` | ① 窗口捕获黑屏：少数 DirectX 独占全屏/UWP 窗口 `PrintWindow` 渲染不出内容，回退 `BitBlt` 需窗口可见（换区域捕获框住它）；② 窗口最小化时 rect 只有 ~160×28，解不出码属正常，还原窗口即可；③ 捕获中窗口被关闭→`IsOpen=false`→producer 自停并提示「视频源已关闭」；若提示未出现而空转，查 `HandleFrameSourceLost` 是否被同步调用（必须 `Task.Run`，否则自 join 死锁）；④ 选择器单击选不中窗口：`EnumWindows` 过滤条件（本进程/工具窗/cloaked/<64px）把目标排除了，或覆盖窗 DPI 换算错位（多屏混合 DPI 场景查 `PinToMonitor`） |
| Windows 端扫码即崩（Rust panic） | `cffi.rs` + `ReceiverSession.cs` | 同 Android：恶意/越界输入应在 Rust `Frame::from_bytes` 拦截；检查 `panic=abort` 下 DLL 是否正确编译 |
| **Windows 分段接收：某段到 100% 后进度回到 0，或切到下一段后有效速率 0 B/s** | `ScanViewModel.OnDecoded` + `Scan/CompletedSegmentTracker.cs` | 段存档后换入的新 `ReceiverSession` 又把屏幕上残留的上一段重新初始化。确认 `HandleSegmentedTransfer` 的两处 `SwapReceiverForNextSegment(..., rememberCompleted: true)` 与 `OnDecoded` 里的 `_completedSegments.Contains(payload)` 早退都在；持续接收模式的 `ContinueNextTransfer(..., remember)` 在保存失败时必须传 `false`（否则幂等归档重试被阻断） |
| **Windows 分段大文件恢复失败（"分段账本已完成，但解压或完整性校验失败"）但小文件正常** | `Native/NativeBridge.cs` `DecompressStreamToFile` | 路径参数必须用 UTF-8 `byte[]` + `Encoding.UTF8.GetBytes(s+"\0")`，**不能**用 `[MarshalAs(UnmanagedType.LPStr)] string`：LPStr 是 ANSI（zh-CN 下 GBK），Rust `cffi.rs::cstr` 按 UTF-8 解读（`from_utf8_lossy`），非 ASCII 用户名/`文档` 目录会被破坏成 `U+FFFD` → Rust `open()` 失败 → 分段解压永久失败。store 根在 `MyDocuments\AirFerry\store\...`，中文 Windows 默认 `文档` |
| **Android 旋转屏/退后台时 ANR（"应用无响应"）** | `apps/scanner/.../ui/ScanActivity.kt` `onDestroy` | `onDestroy` 的 native 清理（`ioExecutor.awaitTermination` + `session.destroy()`）必须跑在 daemon 后台线程，**不能**在主线程 `awaitTermination(30s)`：大文件分段 recover（流式解压 + SHA）在 `ioExecutor` 上可能十几秒，主线程阻塞 >5s 必 ANR。镜像 Windows `ScanViewModel` 的 2s quarantine 模式 |
| 接收端 QR 池逐渐退化（扫码越来越慢直至停摆） | `apps/sender/src/pages/ReceivePage.tsx` `spawnQrWorker`（qr worker `error` 事件） | 仅清 `qrBusyRef.current[i]=false` 不够：worker 异常终止（OOM/模块加载失败）后 `captureLoop` 会再次投递给已死的 worker，因无回包 busy 槽仍会永久卡住，反复崩溃后池降为 0。`spawnQrWorker` 里 `error` listener 必须 **终止旧 worker、`spawnQrWorker(i, trackReady)` 替换并重新 `init`**（新 worker ready 前设 busy=true 防投递），池才能保持满编；替换 worker 的 `trackReady` 沿用调用方值，保证 init barrier 或运行中均正确 |
| 网页接收端切传输/重扫时丢会话（进度归零、重新 bootstrap） | `apps/sender/src/workers/receive.worker.ts` `maybePostMeta` | segment 重复检测 IIFE 的 `dropSession()` 必须用 `spawnJobId === activeJobId` 守卫：IIFE 脱离 `messageQueue` 且 `await hasStoredSegment` 期间用户可能已 reset/切传输并 bootstrap 新会话，无条件 `dropSession()` 会误杀新会话 |
| Windows 控件无 Fluent 样式 / 主题色不生效 | `App.xaml` 合并字典 + `Services/ThemeService.cs` | 控件裸样式 → `App.xaml` 必须同时合并 `ui:ThemesDictionary` 与 `ui:ControlsDictionary`（缺后者标准控件无样式）；主题切换后颜色没变 → 该处用了 `StaticResource` 引主题画刷，必须改 `DynamicResource`；自定义语义色（Success/Error/Warning/PreviewBackdrop）在 `Themes/DesignTokens.{Light,Dark}.xaml`，由 ThemeService 随主题换 Source |
| Windows 弹窗死锁或样式不随主题 | `Services/UiMessages.cs` | 弹窗必须走 `UiMessages`（`ui:MessageBox`）且**必须 await**——`ShowDialogAsync()` 在 dispatcher 上同步阻塞（`.Result`/`.GetAwaiter().GetResult()`）会死锁；直接 `System.Windows.MessageBox.Show` 则无视 Fluent 主题 |
| Windows XAML 编译报 Card 没有 Padding / ComboBox、Slider 无 ui: 版 | `Views/*.xaml` | `ui:Card` 继承 ContentControl、**无 Padding 属性**，内边距写到子元素 `Margin`；`ui:ComboBox`/`ui:Slider` **类不存在**（WPF-UI 只有标准控件的隐式主题样式，勿加 `ui:` 前缀）；按钮图标用显式 `<ui:Button.Icon><ui:SymbolIcon Symbol="Xxx24"/></ui:Button.Icon>`（`Icon="Xxx24"` 简写实测不渲染）；`FluentWindow` 无 `TitleBar` 属性元素，标题栏 `ui:TitleBar` 放内容 Grid 首行 |
| Windows 屏幕捕获预览丢灰度 / 屏幕源难扫码（1-bit 位图） | `Scan/ScreenCapture.cs` `EnsureBitmap` | `CreateCompatibleBitmap` 必须传**屏幕 DC**（`GetDC(NULL)`）：内存 DC 默认选着 1×1 单色 stock bitmap，传 `_memDc` 会创建 bmBitsPixel=1 的单色位图，GetDIBits 拿到的不是 BGRA32 |

---

## 5. 文档与代码偏差清单（AI 高风险，务必注意）

> 调研发现多处文档滞后于代码。**修改/引用时一律以代码为准**。下面是已确认的偏差：

1. **JNI 签名已在本轮审计同步**：`docs/api.md`、`docs/SPEC.md` 与 `NativeBridge.kt` 现统一为 `receiverIngest(...): Long`、`receiverProgressJson(...): ByteArray?`、`receiverAssembleBytes(...): ByteArray?`。后续修改 JNI 时须三处同步；位布局见 [`docs/SPEC.md`](docs/SPEC.md) §JNI ingest 状态字。

2. **压缩参数（两端不同，勿混为一谈）**：
   - **浏览器发送端**（`apps/sender/src/wasm/compress.ts:55-64`）：Zstd **level 1**、Xz **level 9**、early-exit 阈值 **70%**（`e10079d`/`c2ae4a2` 提交已调；三算法选优 raw/zstd/xz）。
   - **Rust 核心库**（`core/qr-protocol/src/compress.rs:23,52`）：Zstd **level 22**（`DEFAULT_LEVEL`，:23）、Xz **level 6 + EXTREME**（`XZ_PRESET`，:52）；`compress_with` 在 :139、`decompress_with_limit` 在 :170。zstd 编码器窗口封顶 `ZSTD_WINDOW_LOG_MAX=23`（:81）——流式编码器不声明输入大小时高 level 会固定声明 windowLog=27，接收端解码器同样钳制 23，两端必须成对出现。
   - 两套编码默认值不同是**有意的**：浏览器发送端追求启动快（Zstd Lv1），Rust 原生压缩 API 追求压缩率（Zstd Lv22；XZ Lv6+EXTREME，见 `compress.rs:41-49`）。接收端按标准流解压，不依赖编码级别。引用压缩参数时**必须分清 TS 与 Rust 默认值**，不要合并描述。

3. **版本号/Release 混用（历史教训）**：README/dist/workflow 曾出现版本漂移。**当前权威版本 `1.2.9`**（versionCode=23）。v1.2.9 新增**网页接收端单文件版**（`airferry-receiver-web-standalone-v1.2.9.html`，Chrome/Edge 双击 `file://` 即用；同时修复 FAST ZXing 的堆视图导出与 `em++` 链接）并合入 Python 发送端（独立版本 0.1.0）。v1.2.8 移除 Web WASM 的 SIMD 编译依赖，兼容禁用 WebAssembly SIMD 的加固/虚拟化 Chromium；构建目录名 `simd` 为兼容保留。v1.2.7 新增 Windows 持续接收模式与网页接收端屏幕/标签页捕获来源；v1.2.6 整理 Windows 接收结果页层级；v1.2.5 更新全平台图标并统一 Windows 扫描来源。协议仍为 v1.2.0 引入的 descriptor v5（compress-then-segment）。Windows workflow 已移除硬编码 `VER`，只能由现有 `release_tag` 派生并核对 tag commit；改版本时仍须按 §2.8 第 5 条同步代码中的版本源。

4. **`derive_meta_from_totals` 已废弃**：`receiver.rs` 内仍保留 JNI/ABI 兼容符号，**新代码勿调用**（其 OTI 构建在大文件上会 assert）。现代路径：从描述符帧拿权威 OTI。

5. **wasm-bindgen 双轨制（MV2=0.2.92 旧版 / MV3=0.2.125 新版）**：`core/transfer-engine/Cargo.toml` **默认仍钉死 `=0.2.92`**（js-sys/web-sys `=0.3.69`），**不要**改回宽松的 `"0.2"` / `"0.3"`。`build-wasm.cjs` 只复制 core 与根 Cargo 文件进独立临时目录，将副本 workspace 的 `members` / `default-members` 裁剪为三个核心 crate，避免解析未复制的宿主 Python/PyO3 crate；仅在现代副本升级到 0.2.125/0.3.102、重算副本 lockfile 并编译，源码 Cargo 文件从不写入。`.wasm-build.lock` 串行化发布目录切换。`node --test apps/sender/scripts/test-build-wasm.cjs` 两项测试含临时 workspace 的 `cargo metadata --offline` 验证。
   - **为什么是双轨**：wasm-bindgen 0.2.93+ 默认开 reference-types proposal（`externref` 值类型），仅 Chrome 96+ 支持；Chrome 87/88 会在 `WebAssembly.instantiateStreaming()` 报 `CompileError: invalid value type 'externref'`。Chrome 87 是 MV2 的兼容目标。MV3 使用新版 wasm-bindgen/externref，但与 MV2 一样都是标量 WASM。
   - **⚠️ 实测性能结论（不要据此期待提速）**：对 RaptorQ + Frame + QR RS + 矩阵全链路的 Node benchmark（T=1400、5000 帧）：
     - **旧 SIMD vs 标量**：约 0.95×（**轻微变慢**）。`raptorq` / `fast_qr` 均无 wasm32 SIMD intrinsics；`+simd128` 主要增大 wasm，现已移除。
     - **新版 wasm-bindgen externref**：对 `&mut [u8]` 传递无明显收益。
     - **原真实瓶颈 QR 编码已大幅缓解**：旧 `qrcode` 单帧占主导，现 `fast_qr` ~7-9×。**`fast_qr` 是 vendored 打过补丁的版本**（`Cargo.toml` 顶部 `[patch.crates-io] fast_qr = { path = "core/qr-protocol/vendor/fast_qr" }`），定制点：调用方指定固定 mask 时跳过 8-mask 评估循环（`vendor/fast_qr/src/placement.rs` 的 `place_on_matrix`，`Some(fixed_mask)` 直接应用不再 clone 矩阵 8 次打分），`qr_render.rs:104` 固定用 `Mask::Checkerboard`——AirFerry 帧尺寸恒定、ZXing 能解码任意合法 mask，故最优 mask 搜索不必要，这一改动约 10× 提速。剩余方向：降 symbol size、并行编码（需 SAB+COOP/COEP）、或 RaptorQ GF(256) SIMD。
   - **为什么还保留双产物**：MV2 需兼容老 Chrome，MV3/Web 使用新 wasm-bindgen/externref。`simd` 仅保留为历史构建名。
   - **产物分流**：`wasm-pkg-legacy/`（MV2）+ `wasm-pkg-simd/`（MV3）；`build-all.cjs` 持锁按目标 swap 到 sender 的 `wasm-pkg/`。web 在同一锁下复制 simd 到自有目录，避免并发读写竞态。
   - **升级现代版**：改 `build-wasm.cjs` 顶部 `MODERN` 三元组，跑 `npm run wasm`，确认两个变体及 web/扩展构建。
   - **症状定位**：旧 Chrome 报 `invalid value type 'externref'` → MV2 误用了新版 wasm-bindgen。

6. **WASM 零拷贝 API**：热路径用 `next_qr_scratch` 写入会话内预留缓冲，随即用 `qr_scratch_view` 借用 WASM 内存；`drawMatrix` 必须在下一次可变 WASM 调用前完成。这样避免 JS→WASM copy-in、WASM→JS copy-out 和逐帧分配。

7. **网页端（apps/web）零代码复用 sender**：Vite alias `@/ → ../sender/src/` 跨工程 import；环境自适应见 `options.tsx`（chrome / document.baseURI / standalone）与 worker 内 zstd fallback。**不要在 web 里 fork 业务代码**。

8. **Parcel dev-server 安全回移**：Plasmo 0.90.5 依赖 Parcel 2.9.3，直接 override 到 2.16.x 会触发私有 core adapter / BundleGraph 不兼容。`apps/sender/package.json` 的 `overrides` 钉 `@parcel/core=2.9.3` 防 npm 混装两套 core；`apps/sender/scripts/patch-parcel-dev-server.cjs` 在 postinstall 中把通配 CORS 改为只允许 Chrome/Firefox 扩展 origin，并对 `@parcel/reporter-dev-server` 做 fail-closed 版本断言（`!== 2.9.3` 即抛错，间接保证传递依赖的 `@parcel/core` 也是 2.9.3）。上游版本升级时补丁会 fail closed，必须重审；不要为追求 `npm audit` 数字而删除回移或强升 Parcel。

9. **ROI 调度状态机：全帧每帧是有意行为，不要修改（实测教训）**：Android `QrDecodePool.kt` + Windows `QrDecodePool.cs` 的全帧重锁判定为 `multiMiss % 3 == 0`——因 `multiMiss` 初始为 0 且每次成功后重置为 0，`0 % 3 == 0` 恒真，**效果是稳定成功时每帧都走 1080p 全帧 `decodeMultiY`/`ReadBarcodes`，ROI 热路径（`decodeMultiYTracked`）几乎不可达**。这在代码分析层面看似 bug（注释意图是仅 miss 时全帧；单码路径用 `incrementAndGet() % N` 正确实现了该意图），但**两版 release APK A/B 实测结论：全帧每帧的解码成功率明显优于 ROI 优先**。推测原因：手持场景下帧间抖动 + 多码布局变化超出 35% margin 的 ROI 窗口容忍度，导致 ROI 路径频繁 miss→全帧→miss→全帧的振荡反而不如直接每帧全帧稳定。**结论：有意保留 `multiMiss % 3 == 0` 现状，不要加 `> 0` 守卫或任何等价修改。** 若未来要重新尝试 ROI 优先，必须同时解决：① 增大 `TRACK_MARGIN`（当前 0.35f 可能不够）或改用自适应窗口；② 多码模式下部分码 miss 时的降级策略；③ **必须 release 实测对比，不能仅凭代码分析下结论**。

10. **WASM 接收端导出 + ingest 打包三端共享 + 解压 stub fail-closed（v1.1.6）**：为网页接收端铺路的底层改动，三点：
    - **新增 `ReceiverSessionWasm`**（`core/transfer-engine/src/wasm.rs`）：此前 WASM 只导出发送端（`SenderSessionWasm` + `encode_qr`）。现补齐接收端：`from_descriptor`（校验完整帧 CRC + 描述符 flag → 锁 session id → 摄入使 meta confirmed）/ `new(sid_lo,sid_hi)` 缓存引导 / `ingest` 返回 packed u64 / 元数据 getters / `assemble_raw`（**只重组不解压**）/ `progress_json`。**不暴露 `assemble_result`**——wasm32 下解压 fail-closed（见下），网页接收端走 `assemble_raw` + JS 侧 zstd/xz WASM 自解压 + 校验 CRC32。逻辑级单测在 `core/transfer-engine/tests/wasm_receiver.rs`（6 个，覆盖描述符引导/坏帧拒绝/packed golden/乱序恢复/截断）。
    - **ingest 打包抽共享模块**：原 `jni.rs` 与 `cffi.rs` 各有一份逐字相同的 `pack_ingest_status` + `INGEST_ERROR`（靠注释 + 测试维系一致）。现抽到 `core/transfer-engine/src/ingest_status.rs`，JNI/C ABI/WASM 三端统一引用，杜绝漂移。位布局不变（bit0 complete / bit1 accepted / bits8..23 streak / bits32..63 received_symbols / `received_symbols==u32::MAX` 为错误哨兵）。`docs/SPEC.md` §7 已改为「三端共享」权威描述。
    - **wasm32 解压 stub 改 fail-closed**（`core/qr-protocol/src/compress.rs`）：原 stub 对所有 compression 都 identity 返回（注释「receiver never runs in the browser」）——网页接收端落地后这会静默把压缩字节当原文件。现 `COMPRESSION_NONE` 原样返回（正确），`COMPRESSION_ZSTD`/`COMPRESSION_XZ` 返回 `Err`（fail-closed）。`qr-protocol::Error::Compress` 变体原先 `#[cfg(not(target_arch="wasm32"))]`，已去掉 cfg gate 让 wasm32 也能构造该错误。网页接收端不经此路径（用 `assemble_raw`），native/Android 解压不受影响。

11. **网页接收端 M2 兼容路径落地（v1.1.6）**：在 M1（WASM 接收端导出）基础上，落地端到端可用的网页接收端（除真机摄像头 A/B 外）：
    - **接收端源码组织**：`apps/sender/src/receive/{decompress,parse}.ts`（解压+解析，被 web 复用）、`apps/sender/src/workers/{receive,qr-decode}.worker.ts`（串行 ingest / ZXing 解码 worker）、`apps/sender/src/pages/ReceivePage.tsx`（相机+取帧+worker 编排+结果分流 UI）。web 入口 `apps/web/src/receiver.tsx` + `apps/web/receiver.html`。
    - **解压路径不走 `@foxglove/wasm-zstd` JS 包**：该包内部 `require("./wasm-zstd.wasm")` 会触发 Vite「ESM integration proposal for Wasm」报错（worker 打包时静态分析到）。改为复用 sender `compress.ts` 已有的 Emscripten 手动实例化单例——给它补绑 `_decompress`（wasm 的 `j` 导出，原本只绑 compress 相关），导出 `zstdDecompress` + `ensureZstdLoaded`，receive worker 直接用。同一个 zstd wasm 文件、同一个 Emscripten 实例，不重复加载。
    - **Vite 多页面 + worker ES 格式**：发送端与接收端用**两个独立 Vite 配置 + 独立入口**——`vite.config.ts`（`rollupOptions.input:{index}`，产出 `dist/`，发送端 `index.html` 单入口）、`vite.receiver.config.ts`（`rollupOptions.input:{receiver}`，产出 `dist-receiver/`，接收端 `receiver.html` 单入口）；两份都开 `worker.format:"es"`（worker 含 `import("zxing-wasm/reader")`/`import("lzma-wasm")` dynamic import 产生 code-split，默认 iife 不支持）。`zxing-wasm`/`lzma-wasm` 装在 web node_modules，用 alias 指向其 dist 入口（sender/node_modules 无此包，否则 worker rollup 解析失败）。`optimizeDeps.exclude` 加 `@foxglove/wasm-zstd`（虽不再直接 import，保留排除以防误预打包）。
    - **zxing-wasm 兼容路径**：M2 用 `zxing-wasm/reader` 的 `readBarcodesFromImageData`（RGBA 全帧，无手动 ROI tracker）。`zxing_reader.wasm` 由 `prepare-wasm.cjs` 复制到 `public/` 供 worker 运行时 fetch。**⚠️ 默认 locateFile 走 jsDelivr CDN**：zxing-wasm 的 `share.ts` 默认 `locateFile` 把 `*_*.wasm` 解析到 `https://fastly.jsdelivr.net/npm/zxing-wasm@...`，离线/CDN 被墙时 `getZXingModule` 加载失败（表现为 `[qr] WORKER ERROR: @undefined:undefined` 或 init 超时）。`qr-decode.worker.ts` 的 `ensureReady` 传 `locateFile: (f) => new URL("../" + f, self.location.href)` 覆盖为**本地**加载（worker 在 `assets/`，wasm 在站点根 `../zxing_reader.wasm`，相对路径兼容子路径部署）。standalone 版预置 `__ZXING_READER_WASM__`，`locateFile` 直接返回该 wasm 的 Blob URL（`Module.wasmBinary` 仍用于 FAST；注意 Emscripten 的 `findWasmBinary()` 即使有 `wasmBinary` 也会先调 `locateFile`，所以 FAST 也必须同时提供 `locateFile`）。**M3 自编译 ZXing-C++ WASM 快路径已落地**：`core/zxing-decoder/{zxing_wasm.cpp,CMakeLists.txt,link-wasm.sh}` + `scripts/build-fastzxing.sh`（Emscripten 3.1.64 编译 ZXing-C++ v3.0.2 固定 commit `8dd1cf5...`，`-O3` 标量构建，产物 `apps/sender/src/fastzxing/airferry_zxing.js/.wasm`，约 700 KB / gzip 331 KB）。构建需 Emscripten（`source ~/emsdk/emsdk_env.sh`）；复用 Android 缓存 zxing-src 用 `./scripts/build-fastzxing.sh --use-cache`，否则 FetchContent 下载。**生产 web 接收端经 `pages.yml` CI 构建默认启用**：CI 跑 `mymindstorm/setup-emsdk@v14`（3.1.64）+ `build-fastzxing.sh` 生成产物，`prepare-wasm.cjs` 拷到 `apps/web/public/`，worker 运行时用 `new URL("../airferry_zxing.js", self.location.href)` 加载（与 `zxing_reader.wasm` 同 public-root 机制）。本地构建无此产物则回退 zxing-wasm（不阻断）。
    - **测试**：`core/transfer-engine/scripts/e2e_receiver.mjs` Node 端到端验证（41 断言，覆盖单文件/ETTEXTv1/ETBUNDL1/小文件全链路：帧生成→ingest→assemble_raw→解析）。真机摄像头 A/B（M6）需硬件，未覆盖。
    - **zstd decompress 导出扩展**：`compress.ts` 的 `ZstdWasmModule` 接口加 `_decompress`，`instantiateZstd` 绑定 `instance.exports.j`。**注意**：这是 `@foxglove/wasm-zstd` 的 `wasm-zstd.wasm`（含 decompress 导出），不是 sender 压缩路径新引入的——该 wasm 本就有 decompress，只是 compress-only 路径没绑。

12. **Windows UI 重做：WPF-UI Fluent 主题**：Windows 端 UI 从零散硬编码深色样式重做为 lepo.co **WPF-UI 4.3.0** Fluent 设计体系（csproj 新增唯一 UI 库 PackageReference；CI 已有显式 `dotnet restore`，workflow 无需改动）。要点：
    - **窗口壳换代**：旧「`App.xaml StartupUri` 直指 Page → WPF 隐式包 NavigationWindow」废弃，改为显式 `Views/MainWindow.xaml`（`ui:FluentWindow`，内容 Grid 首行 `ui:TitleBar` + 第二行 `Frame`，`JournalOwnership=OwnsJournal` + `NavigationUIVisibility=Hidden` 隐藏系统导航栏，各页自绘返回按钮）。⚠️ 4.x 没有 `FluentWindow.TitleBar` 属性元素写法。`App.OnStartup` 手动 `new MainWindow().Show()`（ContentStore 迁移 / ShareExport 清理逻辑不变）。7 个 Page 的导航 API（`NavigationService?.Navigate/GoBack`，共 17 处）无需迁移；仅设备启动一处 `ScanView` 构造参数改为 `ScanSource`、屏幕捕获入口新增一处。
    - **主题**：浅色为主 + 深色可选 + 跟随系统。`settings.json` 新增 `theme` 键（`light`/`dark`/`system`），`Services/AppSettings.cs` 独占读写（保留手写 JSON 解析与跨端格式；两个键整文件重写互不掉落）。`Services/ThemeService.cs` 应用偏好：`ApplicationThemeManager.Apply(theme, WindowBackdropType.None, updateAccent:false)`（显式浅/深）或 `SystemThemeWatcher.Watch(window, None, updateAccents:false)`（接收切换通知；浅/深判定由 `OnLibraryThemeApplied` 按 `AppsUseLightTheme` 注册表纠正——库的主题文件名匹配在浅色系统上会误判 Dark，见 §3.4 主题行），随后 `ApplicationAccentColorManager.Apply(#2563EB, effective)` 统一品牌主色、替换 `Themes/DesignTokens.{Light,Dark}.xaml` 字典 Source。**所有主题相关画刷引用必须 `DynamicResource`**。
    - **控件约定（真机实测修正后）**：卡片 `ui:Card`（无 Padding——继承 ContentControl，内边距放子元素 Margin；需拉伸时显式 Vertical/HorizontalAlignment）；按钮 `ui:Button Appearance=...`，**图标一律显式 `<ui:Button.Icon><ui:SymbolIcon Symbol="Xxx24"/></ui:Button.Icon>`**（`Icon="Xxx24"` 简写不渲染），**满宽按钮须显式 `HorizontalAlignment="Stretch"`**（样式默认左对齐）；状态条 `ui:InfoBar`（替代原硬编码 `#22C55E`/`#EF4444` TextBlock）；`ComboBox`/`Slider` 用**标准控件**（WPF-UI 4.3.0 无 `ui:` 包装类，ControlsDictionary 隐式样式接管）。弹窗统一 `Services/UiMessages.cs`（`ui:MessageBox`，必须 await，禁止同步阻塞）。
    - **ScanView 进度环**：仍为代码绘制（`ScanView.xaml.cs DrawProgressRing`），新增半透明黑底圆 + 白色百分比文字，保证浅/深主题下在摄像头画面上都可读；进度弧画刷走 `FindResource("AccentFillColorDefaultBrush")`。
    - **RegionPickerWindow 保持主题无关**：全屏半透明覆盖层（`AllowsTransparency=True` 与 FluentWindow 不兼容，保持普通 Window），选区框色随品牌色更新为 `#2563EB`。多屏（含 2752×1152 等混合分辨率）实测可正常显示与选区。

---

## 6. 架构关键不变量（速览，详见 [`docs/SPEC.md`](docs/SPEC.md)）

- **同一份 Rust 源码** → 浏览器 `wasm32-unknown-unknown`（wasm-bindgen）、Android `aarch64-linux-android`（`#[no_mangle] extern "system"` JNI）、Windows `x86_64-pc-windows-msvc`（`#[no_mangle] extern "C"` C ABI，供 .NET P/Invoke）及 Python/PyO3 abi3 扩展。编解码数学一致。
  - **浏览器扩展（apps/sender）与网页端（apps/web）共用 TS 源码和构建出的 WASM 变体**。MV2 选 legacy，MV3 与 web 选 simd/modern；sender 的 `wasm-pkg/` 是当前扩展目标快照，web 有独立 `apps/web/wasm-pkg/` 快照。两者由共享锁协调发布。web 通过 Vite alias 跨工程 import，**不单独编译 Rust、不复制业务代码**。
- **帧格式**：`[Header 60B][Payload T][Footer 4B]`，大端，magic `0x4554`，version 1，双层 CRC32；T=symbol_size（浏览器默认 1400——`DEFAULT_CONFIG.symbolSize`，核心库默认 1024——`Config::default()`）。
- **会话 ID**：FNV-1a 128-bit（name/size/mtime/指纹），确定性 → 断点恢复。Rust 与 TS 实现必须位一致。
  - Python 复用同一 `SessionId::derive` 算法，fingerprint 独立绑定原文件 SHA-256、压缩标签、`symbol_size`（小端）和精确压缩流 SHA-256；改编码参数或压缩结果即换会话，防不同 OTI/压缩流混用旧符号，详见 `docs/build-python.md`。
- **喷泉码发射**：源符号跨块轮询发一遍 → 持续新鲜修复符号（ESI 单调递增、不重复）；每块到 24 位 ESI 上限时明确停止，绝不回绕。进度近似线性，无 coupon-collector 拖尾。
- **接收端安全生命线**：`panic = "abort"` 构建，任何 panic = 进程崩溃。`ObjectMeta::validate` + `decompress_with_limit` 是把恶意/越界输入挡在解码器前的防线。
- **线程模型**：原生 receiver 句柄**非线程安全**。Android 用一把 `ingestLock` 串行化所有摄入；ZXing 解码在 N 个 worker 上并行。

---

## 7. 约定

- **语言**：文档、提交信息均用中文；代码注释中英混合（Rust 偏英文 doc-comment，TS 偏英文）。
- **构建 profile**：`release` 用 `opt-level="z"` + LTO + `panic="abort"`（求小体积）；但热路径 crate（raptorq-core / qr-protocol / raptorq / fast_qr / crc32fast / transfer-engine）单独提升到 `opt-level=3`（见 `Cargo.toml`）。
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
| API 参考 | [docs/api.md](docs/api.md) |
| 构建指南 - 浏览器 | [docs/build-browser.md](docs/build-browser.md) |
| 构建指南 - 网页端 | [docs/build-web.md](docs/build-web.md) |
| 构建指南 - Android | [docs/build-android.md](docs/build-android.md) |
| 构建指南 - Windows | [docs/build-windows.md](docs/build-windows.md) |
| 开发环境搭建 | [docs/dev-setup.md](docs/dev-setup.md) |
