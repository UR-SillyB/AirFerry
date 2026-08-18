# 前端与网页端构建说明 (Web & Extension Targets Build)

> 浏览器扩展、Web 发送端、Web 接收端与单文件版统一收敛于 `apps/web`：单一 `package.json`、单一事实源，零跨目录别名。本文覆盖这 7 个目标的完整构建链路；Android 见 [build-android.md](build-android.md)，Windows 见 [build-windows.md](build-windows.md)。

## 前置条件

- Node.js ≥ 18 + npm
- Rust + wasm-pack（见 [开发环境搭建](dev-setup.md)）
- Emscripten（emcc，接收端 FAST ZXing-C++ 解码后端必需，见下文）
- 打包发布产物（可选）：macOS 上安装的 Google Chrome，用于签名 `.crx`

## 构建 WASM 核心（单产物）

```bash
cd apps/web
npm run wasm
```

此命令（`scripts/build-wasm.cjs`）把 `core/transfer-engine` 编译为**单一**标量 WebAssembly 产物：

| 产物目录 | wasm-bindgen 版本 | 特性 | 兼容性 |
|---------|------------------|------|--------|
| `wasm-pkg/` | `=0.2.92`（锁定） | 标量、无 SIMD、无 externref | Chrome 87 → 最新版全兼容 |

> **工作树隔离**：脚本把 workspace 复制到临时目录编译，源码 `Cargo.toml` / `Cargo.lock` 从不写入。`.wasm-build.lock` 跨进程锁阻止并发构建互相覆盖产物目录。

> **为何单产物**：实测 `+simd128`/externref 对纯标量的 `raptorq`/`fast_qr` 热路径无收益（0.95× 反而略慢），双产物（legacy + simd）只会加倍构建矩阵与兼容面。单一 0.2.92 标量产物通吃 Chrome 87 到最新版。

## 接收端解码后端（FAST ZXing-C++，硬性要求）

网页接收端的 QR 解码**只有** FAST ZXing-C++ 一个后端（自编译，Y 灰度平面；zxing-wasm 兼容回退已移除）：

```bash
./scripts/build-fastzxing.sh            # 全量编译（emcmake）
./scripts/build-fastzxing.sh --use-cache # 复用缓存（日常）
```

产物 `airferry_zxing.js/.wasm` 输出到 `apps/web/src/fastzxing/`（权威位置），再由 `prepare-wasm.cjs` 拷入 `apps/web/public/` 供接收端运行时 fetch。**产物缺失即构建失败**（emcc 不在 PATH 时 `build-all.sh web` 会直接报错退出并提示安装 Emscripten 3.1.64）。

## 构建浏览器扩展（Vite）

### 全部目标（推荐）

```bash
cd apps/web
npm run build:ext
```

一次性构建全部 4 个目标（共用同一份 `wasm-pkg/`），产物在 `apps/web/build/`：

| 目标目录 | 支持浏览器 |
|---------|-----------|
| `chrome-mv3-prod` | Chrome / Edge（MV3，Chrome 88+ / Edge 88+） |
| `chrome-mv2-prod` | Chrome / Edge（MV2 遗留，旧版浏览器，最低 Chrome 87） |
| `firefox-mv3-prod` | Firefox（MV3，Firefox 116+） |
| `firefox-mv2-prod` | Firefox（MV2 遗留，Firefox 91+） |

### 单独构建某个目标

```bash
npm run build:chrome-mv3    # Chrome / Edge MV3
npm run build:chrome-mv2    # Chrome / Edge MV2
npm run build:firefox-mv3   # Firefox MV3
npm run build:firefox-mv2   # Firefox MV2
```

### 扩展构建流水线

`scripts/build-ext.cjs` 使用 Vite API 自动执行：

- **Options 页面构建**：编译 `options.html` + `src/options.tsx` + Web Workers + WASM
- **Background 构建**：将 `src/background/index.ts` 编译为无依赖的 IIFE `background.js`
- **图标处理**：将 `assets/icon{16,32,48,64,128}.png` RGBA 图标复制进产物目录
- **Manifest 生成**：按目标平台（MV2/MV3、Chrome/Firefox）生成规范的 `manifest.json`，并自动注入版本号

### 开发模式与加载

- **Chrome / Edge**：`chrome://extensions` → 开发者模式 → 拖入 `.crx`，或「加载已解压的扩展程序」选择 `apps/web/build/chrome-mv3-prod/`（或 mv2）。
- **Firefox**：`about:debugging#/runtime/this-firefox` → 「临时载入附加组件」→ 选 `build/firefox-mv3-prod/manifest.json`（或 MV2），或拖入 `.xpi`。正式版 Firefox 拒绝未签名 `.xpi`，需 Developer/Nightly 关闭 `xpinstall.signatures.required` 或走临时载入（详见 [README → Firefox 扩展](../README.md#firefox-扩展)）。
- **使用**：点工具栏 AirFerry 图标 → 新标签页打开完整应用（无 popup）→ 添加文件/文字 → 「发送」→ 参数页 → 播放二维码视频流。

## 构建网页端（Vite）

### 命令

```bash
cd apps/web
npm install            # 首次（依赖安装）

npm run dev            # Vite HMR 开发
npm run dev:receiver   # 接收端本地开发
npm run build          # 发送端静态站点 → dist/（index.html 单入口）
npm run build:receiver # 接收端静态站点 → dist-receiver/（receiver.html 单入口）
npm run build:standalone # 发送端单文件版 → dist-standalone/index.html
npm run build:all      # 构建全部 7 个目标（4 扩展 + 3 网页）
npm run preview        # 本地预览构建产物
```

发送端与接收端**分开构建、独立 zip**，各自自包含、可独立部署。

每个 build 命令都有对应 `prebuild` 钩子（`scripts/prepare-wasm.cjs`）：
1. 校验 `apps/web/wasm-pkg/` 的 JS + WASM 完整（缺失则报错并提示先跑 `cd apps/web && npm run wasm`）；
2. 把 FAST ZXing 产物（`airferry_zxing.js/.wasm`）从 `apps/web/src/fastzxing/` 拷到 `public/`（缺失即失败，FAST-only）。

> 说明：压缩/解压在 Rust 核心内完成（`transfer-engine` WASM），前端不再单独携带 zstd WASM。

> 用根目录 `./scripts/build-all.sh web` / `release` 构建时会自动完成 Rust WASM 与 FAST ZXing 的重编，无需手动前置。

### 产物结构

```
apps/web/dist/                     # 发送端（airferry-sender-web-v{VER}.zip）
├── index.html                     # 发送端入口（资源用相对路径 ./assets/...）
├── favicon-sender.png
└── assets/
    ├── index-*.js / *.css         # 主应用（发送端页面与组件）
    ├── compress.worker-*.js       # 压缩 worker
    └── transfer_engine_bg-*.wasm  # Rust 核心引擎（apps/web/wasm-pkg/）

apps/web/dist-receiver/            # 接收端（airferry-receiver-web-v{VER}.zip）
├── receiver.html
├── favicon-receiver.png
└── assets/
    ├── receiver-*.js / *.css      # 接收端主应用（ReceivePage + worker 编排）
    ├── qr-decode.worker-*.js      # QR 解码 worker 池
    ├── receive.worker-*.js        # 串行 ingest worker
    ├── airferry_zxing-*.js/.wasm  # FAST ZXing 快路径（Y 平面解码，唯一后端）
    └── transfer_engine_bg-*.wasm
```

### 部署

`dist/` 与 `dist-receiver/` 都是纯静态文件：`base: "./"` 相对路径，可部署到 GitHub Pages（子路径也正常）、Netlify / Vercel / Cloudflare Pages，或任意 `nginx`/`caddy`/`python -m http.server`。

> **不需要 COOP/COEP 头**：核心传输不依赖 `SharedArrayBuffer`（压缩在普通 Web Worker，QR 渲染在主线程 Canvas）。

### 局域网 HTTPS 接收端测试（`serve-https.mjs`）

> ⚠️ 网页接收端是多文件静态站点，不能像单文件版那样双击打开；且 `getUserMedia`（摄像头）只在**安全上下文**（HTTPS 或 localhost）可用。局域网真机扫码测试需用 HTTPS 静态服务器：

```bash
cd apps/web
npm run build:receiver   # 构建接收端 dist-receiver/

# 用法: node scripts/serve-https.mjs <serveDir> <crt> <key> [port]
node scripts/serve-https.mjs dist-receiver .cert/selfsigned.crt .cert/selfsigned.key 8765
```

- 自签证书在 `apps/web/.cert/`（git-ignored）；浏览器访问会警告，点「高级」→「继续」即可。
- 默认端口 **8765**，监听 `0.0.0.0`；根路径 `/` 自动映射到 `receiver.html`。

## 扩展与网页端的关系

扩展与网页端共用同一份 `apps/web/src/`（单一事实源、零重复）：业务代码与 Rust WASM 完全一致，只是入口、构建目标与部署形态不同。

| 维度 | 浏览器扩展 | 网页端 |
|------|-----------|--------|
| 入口 | 点图标 → `background/index.ts` 开新标签页（`options.html`） | 直接访问网页 URL（`index.html` / `receiver.html`） |
| 构建 | `npm run build:ext`（Vite + 扩展流水线） | `npm run build` / `build:receiver` / `build:standalone`（Vite 纯 SPA） |
| 业务源码 | `apps/web/src/`（单一事实源） | `apps/web/src/`（同一份） |
| Rust WASM | `npm run wasm` → `apps/web/wasm-pkg/`（`@airferry-wasm` alias） | 同一 `apps/web/wasm-pkg/` |
| 部署形态 | `.crx`/`.xpi`/`.zip` 扩展包 | 纯静态网站（`dist/`、`dist-receiver/`、`dist-standalone/`） |
| 扩展 API | `chrome.runtime.getURL` 等 | `typeof chrome` 判断后走网页 fallback（`document.baseURI`） |

环境自适应由 `typeof chrome !== "undefined"` 判断：扩展走 `chrome.runtime.getURL`，网页走 `new URL(..., document.baseURI)`（子路径部署正确）。网页接收端的 receive worker 在 post `init` 前 `await` 预加载 Rust WASM 并 post `wasm-init`（worker 消息 FIFO 保证先于 assemble）。

## 单文件版（双击运行，无需服务器）

普通 `dist/` 需要静态服务器（ES module 脚本在 `file://` 下被禁）。**单文件版**把所有资源内联进一个 `index.html`，**双击即可在 `file://` 下运行**。

```bash
cd apps/web
npm run build:standalone    # 产出自包含单文件 dist-standalone/index.html（约 2MB）
```

两阶段构建：① `vite build --config vite.standalone.config.ts`（IIFE bundle + worker 单独 ES chunk + WASM 资源）；② `node scripts/build-standalone.cjs` 后处理内联全部 JS/CSS/worker/WASM（zstd + transfer_engine）。

### file:// 下的三大障碍及解法

| 障碍 | 解法 |
|------|------|
| `<script type="module">` 在 file:// 被禁 | IIFE bundle（无 module 标记），内联为普通 `<script>` |
| `new Worker(url)` 在 file:// 加载失败 | worker 源码字符串化 → `URL.createObjectURL(new Blob([code]))` |
| WASM `fetch(import.meta.url)` 在 file:// 失败 | WASM base64 内联，运行时 `atob` 解码喂给 buffer 接口 |

后处理脚本（`build-standalone.cjs`）的关键细节：内联 JS 中的 `</script>` 转义为 `<\/script>`；worker chunk 的 `import.meta` 替换为字符串字面量（Blob classic worker 不支持）；注入 `process.env.NODE_ENV` polyfill。

### 与普通版的区别

| 维度 | 普通版（`npm run build`） | 单文件版（`npm run build:standalone`） |
|------|--------------------------|---------------------------------------|
| 产物 | `dist/` 多文件 | 单个 `dist-standalone/index.html`（约 2MB） |
| 运行 | 需静态服务器 | **file:// 双击即用** |
| WASM | 外部文件，运行时 fetch | base64 内联 |
| Worker | ES module worker | Blob URL classic worker |

## 打包发布产物

构建 + 打包由根目录一键脚本完成，版本号取自 `apps/web/package.json`：

```bash
./scripts/build-all.sh release   # 构建 + 打包到 dist/（含 crx/xpi 签名）
./scripts/build-all.sh dist      # 仅打包（各端产物已构建好）
```

产物（`dist/`，均 git-ignored，通过 GitHub Release 分发）：

| 产物 | 说明 |
|------|------|
| `airferry-sender-chrome-mv3-v<VER>.crx` / `.zip` | Chrome/Edge MV3（crx 已签名 Cr24；zip 为解压加载回退） |
| `airferry-sender-chrome-mv2-v<VER>.crx` / `.zip` | Chrome/Edge MV2 |
| `airferry-sender-firefox-mv3-v<VER>.xpi` | Firefox MV3（zip→xpi，未经 Mozilla 签名） |
| `airferry-sender-firefox-mv2-v<VER>.xpi` | Firefox MV2 |
| `airferry-extension.pem` | Chrome 固定签名私钥（须预先配置，git-ignored；脚本核对公钥指纹，绝不自动换钥） |

**Chrome crx 签名机制**：脚本调用 Chrome `--pack-extension` 生成 Cr24 签名。首次（无 pem）由 Chrome 生成新私钥并挪到 `dist/airferry-extension.pem`；后续用 `--pack-extension-key` 复用同一私钥，MV2/MV3 得到**相同的扩展 ID**。找不到 Chrome（Linux/CI）时 warn 跳过 crx，仅保留 zip。**私钥决定扩展 ID，务必妥善保管；丢失后无法再为同一扩展 ID 签名。**

## 调试

| 症状 | 原因 | 解决 |
|------|------|------|
| 启动报 `transfer_engine.js not found` | `apps/web/wasm-pkg/` 缺失或不完整 | `cd apps/web && npm run wasm`，再重跑 web 命令 |
| 压缩总是 100%（走 raw） | Rust 核心压缩未生效 | 重跑 `npm run wasm`（Rust 侧 `qr-protocol/compress.rs` 负责 zstd/xz，前端无独立压缩 WASM） |
| 接收端构建报 FAST ZXing 缺失 | `apps/web/src/fastzxing/` 无产物 | `./scripts/build-fastzxing.sh`（需 emcc） |
| 跨工程 import 报 `@/` 找不到 | Vite alias 未生效 | 确认 `vite.config.ts` 的 `resolve.alias` 含 `{ find: "@/", replacement: "<repo>/apps/web/src/" + "/" }` 与 `@airferry-wasm/` → `apps/web/wasm-pkg/` |
