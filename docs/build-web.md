# 网页端构建说明 (Web Build)

> 网页端是一个**纯静态网站**，功能与浏览器扩展完全一致（统一选择列表：文件/文件夹可拖到页面任意位置，也可点选；添加文字后点「发送」；三算法压缩、零拷贝 QR 渲染、多码模式、亮度优化）。它通过 Vite alias **直接复用 `apps/sender/src/` 的全部源码**，不复制任何业务代码——改 sender，网页端自动同步。

## 前置条件

- Node.js ≥ 18
- npm
- **`apps/sender/wasm-pkg-simd/` 必须完整**（Rust WASM 现代标量产物；`simd` 为历史目录名，网页端复用它，不单独编译 Rust）

## 构建 WASM 核心

网页端复用浏览器扩展的 Rust WASM 产物。**用 `build-all.sh web` / `release` 构建时无需手动前置**——v1.2.0 起 `build_web` 会自动 `npm run wasm` 重编 `wasm-pkg-simd/`，并调 `scripts/build-fastzxing.sh --use-cache` 重编 FAST ZXing-C++（`airferry_zxing.js/.wasm`），确保进包的都是最新源码产物而非旧中间产物。

若直接在 `apps/web` 下跑 `npm run build`，则需先在 sender 下生成 WASM（首次或源码变更后）：

```bash
cd apps/sender
npm install            # 首次
npm run wasm           # 生成 legacy/simd 两个标量变体（simd 为历史名）
```

> 网页端明确使用现代/MV3 变体。`prepare-wasm.cjs` 每次都校验 sender 的 `wasm-pkg-simd`，持跨进程锁原子复制到 **web 自有**的 `apps/web/wasm-pkg/`；扩展构建切换自己的 MV2/MV3 包时不会改动 Vite 正在读取的文件。

> 若 `apps/sender/wasm-pkg-simd/{transfer_engine.js,transfer_engine_bg.wasm}` 不完整，`predev`/`prebuild`/`prebuild:standalone` 会报错退出并提示先跑此步。

> **FAST ZXing-C++（接收端加速后端）**：`build_web` 在 **emcc 可用时**通过 `scripts/build-fastzxing.sh --use-cache` 重编 `airferry_zxing.js/.wasm` 到 `apps/sender/src/fastzxing/`，再被 `prepare-wasm.cjs` 拷到 `public/`（此前 `build-all.sh` 从不调用它，本地发布可能带上一次遗留的旧快路径产物）。**emcc 缺失时 `build_web` 显式 `warn`（不静默）**，接收端回退 zxing-wasm 兼容后端，构建不中断；发布前请在带 Emscripten 的环境运行 `./scripts/build-fastzxing.sh` 以确保 FAST 快路径最新。

## 构建网页端

```bash
cd apps/web
npm install            # 首次（含 postinstall: 提取 lzma-wasm）

npm run dev            # Vite HMR 开发（http://localhost:5180）
npm run build          # 产出静态站点 dist/
npm run preview        # 本地预览构建产物（默认 http://localhost:4173）
```

`npm run build` 会先跑 `prebuild`（`scripts/prepare-wasm.cjs`）：
1. 校验 `apps/sender/wasm-pkg-simd` 的 JS + WASM，并持锁原子复制到 `apps/web/wasm-pkg/`
2. 把 `@foxglove/wasm-zstd/dist/wasm-zstd.wasm` 拷到 `apps/web/public/wasm-zstd.wasm`（供压缩 worker 运行时 fetch）

`npm run build:standalone` 也有相同的 `prebuild:standalone` 前置，不会在缺少 `wasm-zstd.wasm` 时先成功打包、再在后处理阶段失败。

## 构建命令（发送端 / 接收端拆分）

v1.1.6 起发送端与接收端**分开构建、独立 zip**：

```bash
npm run build           # 发送端 → dist/（index.html 单入口）
npm run build:receiver  # 接收端 → dist-receiver/（receiver.html 单入口）
npm run build:standalone  # 发送端单文件版 → dist-standalone/index.html
```

两个产物各自自包含、可独立部署；发送端 zip 打包时排除 `zxing_reader.wasm`（接收端 QR 解码专用）。

## 产物结构

```
apps/web/dist/                     # 发送端（airferry-sender-web-v{VER}.zip）
├── index.html                     # 发送端入口（资源用相对路径 ./assets/...）
├── favicon-sender.png             # 发送端标签页图标
├── wasm-zstd.wasm                 # zstd 压缩 WASM（主线程预加载后 post 给 worker；运行时 fetch 仅回退路径）
└── assets/
    ├── index-*.js                 # 主应用（含复用的 sender 页面/组件）
    ├── index-*.css                # 样式
    ├── compress.worker-*.js       # 压缩 worker（含 zstd/xz/CRC/session 逻辑）
    ├── transfer_engine_bg-*.wasm  # Rust 核心引擎（来自 web 自有 WASM 快照）
    ├── lzma_wasm_bg-*.wasm        # xz 压缩 WASM
    └── icon128-*.png              # 复用 sender 的图标

apps/web/dist-receiver/            # 接收端（airferry-receiver-web-v{VER}.zip）
├── receiver.html                  # 接收端入口
├── favicon-receiver.png           # 接收端标签页图标
├── wasm-zstd.wasm                 # zstd 解压 WASM（主线程预加载后经 `wasm-init` 传 receive worker）
├── zxing_reader.wasm              # QR 解码 worker 运行时 fetch
└── assets/
    ├── receiver-*.js              # 接收端主应用（ReceivePage + worker 编排）
    ├── receiver-*.css             # 接收端样式
    ├── qr-decode.worker-*.js      # QR 解码 worker 池
    ├── receive.worker-*.js        # 串行 ingest worker
    ├── airferry_zxing-*.js/.wasm  # fastzxing 快路径（Y 平面解码）
    ├── transfer_engine_bg-*.wasm  # Rust 核心引擎
    ├── lzma_wasm_bg-*.wasm        # xz 解压 WASM
    └── receiver-icon128-*.png     # 接收端页面品牌图标
```

## 部署

发送端 `dist/` / 接收端 `dist-receiver/` 都是纯静态文件，可部署到任意静态托管：

- **GitHub Pages**：把 `dist/`（或 `dist-receiver/`）内容推到 `gh-pages` 分支或配置 Actions 构建。`base: "./"` 用相对路径，部署到子路径（如 `user.github.io/repo/`）也正常。
- **Netlify / Vercel / Cloudflare Pages**：构建命令 `npm run build`（发送端）/ `npm run build:receiver`（接收端），发布目录 `apps/web/dist` 或 `apps/web/dist-receiver`。
- **任意静态服务器**：`nginx`/`caddy`/`python -m http.server` 直接托管对应目录。

> **不需要 COOP/COEP 头**：核心传输功能不依赖 `SharedArrayBuffer`（压缩在普通 Web Worker 里跑，QR 渲染在主线程 Canvas）。若未来引入多线程并行编码才需配置 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`。

### 局域网 HTTPS 接收端测试（`serve-https.mjs`）

> ⚠️ **网页接收端不能像发送端单文件版那样双击打开**：它是多文件静态站点（module 脚本/Worker/WASM 均为独立文件），必须先部署。`getUserMedia` 要求安全上下文；常规部署需 HTTPS 或 localhost（普通 http 非 localhost 不可用）。注意 Chromium 的 `file://` 本身是安全上下文（Chrome 实测摄像头与 Blob module worker 可用），所以单文件接收端在 Chrome/Edge 技术上可行，但当前未提供该构建目标——需要把 receive/qr Worker 与全部 WASM 内联并用 Blob URL/`wasmBinary` 注入。局域网真机扫码测试仍建议用 HTTPS 静态服务器。

仓库自带最小实现：

```bash
cd apps/web
npm run build:receiver   # 构建接收端 dist-receiver/（receiver.html 单入口）

# 用法: node scripts/serve-https.mjs <serveDir> <crt> <key> [port]
node scripts/serve-https.mjs dist-receiver .cert/selfsigned.crt .cert/selfsigned.key 8765
```

```bash
cd apps/web
npm run build:receiver   # 构建接收端 dist-receiver/（receiver.html 单入口）

# 用法: node scripts/serve-https.mjs <serveDir> <crt> <key> [port]
node scripts/serve-https.mjs dist-receiver .cert/selfsigned.crt .cert/selfsigned.key 8765
```

- 自签证书已就位在 `apps/web/.cert/`（`selfsigned.crt` + `selfsigned.key`）；浏览器访问会警告，点「高级」→「继续」即可。
- 默认端口 **8765**，监听 `0.0.0.0`（本机 `https://localhost:8765/receiver.html`，局域网 `https://<LAN-IP>:8765/receiver.html`）。
- 根路径 `/` 自动映射到 `receiver.html`（专注接收端测试）。

## 与浏览器扩展的关系

| 维度 | 浏览器扩展（apps/sender） | 网页端（apps/web） |
|------|-------------------------|-------------------|
| 入口 | 图标点击 → `background/index.ts` 开新标签页打开 options.html | 直接访问网页 URL |
| 构建工具 | Plasmo（Parcel 2）+ manifest 后处理 | Vite（纯 SPA） |
| 业务源码 | `apps/sender/src/`（**单一事实源**） | 通过 alias **复用** `apps/sender/src/`，零代码重复 |
| Rust WASM | 自己编译（`npm run wasm`） | 从 sender 的 `wasm-pkg-simd/` 复制私有快照，不单独编译 |
| 部署形态 | `.crx`/`.xpi`/`.zip` 扩展包 | 纯静态网站 |
| 扩展 API | `chrome.runtime.getURL` 等 | `typeof chrome` 判断后走网页 fallback（`document.baseURI`） |

两端共用同一份 `apps/sender/src/options.tsx`——zstd 预加载走共享助手 `apps/sender/src/wasm/zstdPreload.ts` 的 `preloadZstdBytes()`：用 `typeof chrome !== "undefined"` 做环境自适应，扩展走 `chrome.runtime.getURL`，网页走 `new URL("wasm-zstd.wasm", document.baseURI)`，行为各自正确（见 `AGENTS.md` §5.8）。网页接收端的 receive worker 也由 `ReceivePage` 用同一助手**在 post `init` 前 `await` 预加载**并 post `wasm-init`（worker 消息 FIFO 保证先于 assemble；worker 内 `initZstdFromBytes` 安装）。`compress.ts` 的兜底 fetch 按执行环境分流：主线程（`document`）走 `document.baseURI` 同级路径（子路径部署正确），打包 worker（脚本在 `assets/` 下）走 `../wasm-zstd.wasm`——曾统一按 worker 自身 URL 相对 fetch 解析到 `assets/wasm-zstd.wasm` 404（文件在站点根），导致 zstd 压缩传输在接收完成时报错。

## 单文件版（双击运行，无需服务器）

普通 `dist/` 需要静态服务器（因为 ES module 脚本在 `file://` 下被浏览器禁止）。**单文件版**把所有资源内联进一个 `index.html`，**双击即可在 `file://` 下运行**，无需任何服务器。

### 构建

```bash
cd apps/web
npm run build:standalone    # 产出自包含单文件 dist-standalone/index.html（约 2MB）
```

构建过程（两阶段）：
1. `vite build --config vite.standalone.config.ts` —— IIFE bundle（去 ES module 标记）+ worker 单独 ES chunk + WASM 资源
2. `node scripts/build-standalone.cjs` —— 后处理：把 JS/CSS/worker/2 个 WASM（zstd + transfer_engine；lzma 已自内联）全部内联进单个 HTML

### 使用

直接双击 `dist-standalone/index.html`，或在 Finder/资源管理器里打开。无需 `python -m http.server`、无需部署；进入选择页后，可把文件或文件夹拖到窗口任意位置追加。

### file:// 下的三大障碍及解法

| 障碍 | 解法 |
|------|------|
| `<script type="module">` 在 file:// 被禁 | IIFE bundle（无 module 标记），内联为普通 `<script>` |
| `new Worker(url)` 在 file:// 加载失败 | worker 源码字符串化 → `URL.createObjectURL(new Blob([code]))` 生成 blob: URL → `new Worker(blobUrl)` |
| WASM `fetch(import.meta.url)` 在 file:// 失败 | 三个 WASM 全部 base64 内联，运行时 `atob` 解码喂给 buffer 接口 |

### 三个 WASM 的加载方式（复用现成 buffer 接口，零源码改动）

| WASM | 加载方式 |
|------|---------|
| transfer_engine (304KB) | base64 内联 → `init(buffer)`（wasm-bindgen 非字符串输入走 `WebAssembly.instantiate(buffer)`） |
| lzma-wasm | **已自带 base64 内联**（默认 `atob` 自解码，file:// 直接可用） |
| wasm-zstd (412KB) | base64 内联 → 主线程 `initZstdFromBytes(bytes)` → postMessage 传 worker |

### 后处理脚本的关键细节（`build-standalone.cjs`）

1. **`</script>` 转义**：内联 JS 里可能含 `</script>` 字符串，会破坏 HTML 解析。替换成 `<\/script>`（JS 字符串等价，HTML 解析器看不见）
2. **`import.meta.url` 替换**：worker chunk 是 ES 格式含 `import.meta`（lzma wasm-bindgen 胶水），但 Blob worker 是 classic。替换成字符串字面量（该 fetch fallback 路径在单文件版永不执行）
3. **`process` polyfill**：prop-types 等依赖引用 `process.env.NODE_ENV`，file:// 下 `process` 未定义。prelude 注入 `globalThis.process={env:{NODE_ENV:"production"}}`

### 浏览器兼容性

- ✅ **Chrome / Edge / Firefox**（现代版本，1-2 年内）：file:// 双击运行正常
- ⚠️ 单文件版用 Blob URL worker + base64 WASM，依赖较新的浏览器特性
- 大文件压缩（xz level 9）时主线程不冻结（worker 仍在后台跑），体验与扩展版一致

### 与普通版的区别

| 维度 | 普通版（`npm run build`） | 单文件版（`npm run build:standalone`） |
|------|--------------------------|---------------------------------------|
| 产物 | `dist/` 多文件（HTML + assets/ + wasm） | 单个 `dist-standalone/index.html`（约 2MB） |
| 运行 | 需静态服务器（ES module 限制） | **file:// 双击即用** |
| WASM | 外部文件，运行时 fetch | base64 内联 |
| Worker | ES module worker（`new Worker(url, {type:"module"})`） | Blob URL classic worker |
| 体积 | 总和约 1.2MB（可 gzip） | 约 2MB（单文件，无 gzip） |

## 调试

| 症状 | 原因 | 解决 |
|------|------|------|
| 启动报 `transfer_engine.js not found` | `apps/sender/wasm-pkg-simd/` 缺失或不完整 | `cd apps/sender && npm run wasm`，再重跑 web 命令 |
| 压缩总是 100%（走 raw） | `public/wasm-zstd.wasm` 缺失，worker fetch 404 | 重跑 `npm run build`（触发 `prebuild`→prepare-wasm） |
| 跨工程 import 报 `@/options` 找不到 | Vite alias 未生效 | 确认 `vite.config.ts` 的 `resolve.alias` 含 `{ find: "@/", replacement: ".../sender/src/" }` |
