# 网页端构建说明 (Web Build)

> 网页端是一个**纯静态网站**，功能与浏览器扩展完全一致（文件/文字传输、三算法压缩、零拷贝 QR 渲染、多码模式、亮度优化）。它通过 Vite alias **直接复用 `apps/sender/src/` 的全部源码**，不复制任何业务代码——改 sender，网页端自动同步。

## 前置条件

- Node.js ≥ 18
- npm
- **`apps/sender/wasm-pkg/` 必须存在**（Rust WASM 产物，网页端复用它，不单独编译 Rust）

## 构建 WASM 核心（一次性前置）

网页端复用浏览器扩展的 Rust WASM 产物。首次构建前需在 sender 下生成：

```bash
cd apps/sender
npm install            # 首次
npm run wasm           # 生成 wasm-pkg-legacy/ + wasm-pkg-simd/，并复制其中一份到 wasm-pkg/
```

> 网页端只需 `apps/sender/wasm-pkg/`（构建时由 `build-wasm.cjs` 从 legacy/simd 复制而来），对 SIMD 与否不敏感（见 `AGENTS.md` §5.6 实测结论）。若只想最快跑通，单独跑 `npm run wasm:legacy` 也能生成可用的 `wasm-pkg-`。

> 若 `apps/sender/wasm-pkg/transfer_engine.js` 缺失，网页端的 `predev`/`prebuild`（`prepare-wasm.cjs`）会报清晰错误并退出，提示先跑此步。

## 构建网页端

```bash
cd apps/web
npm install            # 首次（含 postinstall: 提取 lzma-wasm）

npm run dev            # Vite HMR 开发（http://localhost:5180）
npm run build          # 产出静态站点 dist/
npm run preview        # 本地预览构建产物（默认 http://localhost:4173）
```

`npm run build` 会先跑 `prebuild`（`scripts/prepare-wasm.cjs`）：
1. 校验 `apps/sender/wasm-pkg/transfer_engine.js` 存在
2. 把 `@foxglove/wasm-zstd/dist/wasm-zstd.wasm` 拷到 `apps/web/public/wasm-zstd.wasm`（供压缩 worker 运行时 fetch）

## 产物结构

```
apps/web/dist/
├── index.html                     # SPA 入口（资源用相对路径 ./assets/...）
├── wasm-zstd.wasm                 # zstd 压缩 WASM（worker 运行时 fetch）
└── assets/
    ├── index-*.js                 # 主应用（含复用的 sender 页面/组件）
    ├── index-*.css                # 样式
    ├── compress.worker-*.js       # 压缩 worker（含 zstd/xz/CRC/session 逻辑）
    ├── transfer_engine_bg-*.wasm  # Rust 核心引擎（复用 sender 的 wasm-pkg）
    ├── lzma_wasm_bg-*.wasm        # xz 压缩 WASM
    └── icon128-*.png              # 复用 sender 的图标
```

## 部署

`dist/` 是纯静态文件，可部署到任意静态托管：

- **GitHub Pages**：把 `dist/` 内容推到 `gh-pages` 分支或配置 Actions 构建。`base: "./"` 用相对路径，部署到子路径（如 `user.github.io/repo/`）也正常。
- **Netlify / Vercel / Cloudflare Pages**：构建命令 `npm run build`，发布目录 `apps/web/dist`。
- **任意静态服务器**：`nginx`/`caddy`/`python -m http.server` 直接托管 `dist/`。

> **不需要 COOP/COEP 头**：核心传输功能不依赖 `SharedArrayBuffer`（压缩在普通 Web Worker 里跑，QR 渲染在主线程 Canvas）。若未来引入多线程并行编码才需配置 `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`。

## 与浏览器扩展的关系

| 维度 | 浏览器扩展（apps/sender） | 网页端（apps/web） |
|------|-------------------------|-------------------|
| 入口 | 图标点击 → `background/index.ts` 开新标签页打开 options.html | 直接访问网页 URL |
| 构建工具 | Plasmo（Parcel 2）+ manifest 后处理 | Vite（纯 SPA） |
| 业务源码 | `apps/sender/src/`（**单一事实源**） | 通过 alias **复用** `apps/sender/src/`，零代码重复 |
| Rust WASM | 自己编译（`npm run wasm`） | 复用 sender 的 `wasm-pkg/`，不单独编译 |
| 部署形态 | `.crx`/`.xpi`/`.zip` 扩展包 | 纯静态网站 |
| 扩展 API | `chrome.runtime.getURL` 等 | `typeof chrome` 判断后走网页 fallback（`document.baseURI`） |

两端共用同一份 `apps/sender/src/options.tsx`——其中的 zstd 预加载 IIFE 用 `typeof chrome !== "undefined"` 做环境自适应，扩展走 `chrome.runtime.getURL`，网页走 `new URL("wasm-zstd.wasm", document.baseURI)`，行为各自正确（见 `AGENTS.md` §5.8）。

## 调试

| 症状 | 原因 | 解决 |
|------|------|------|
| 启动报 `transfer_engine.js not found` | `apps/sender/wasm-pkg/` 缺失 | `cd apps/sender && npm run wasm` |
| 压缩总是 100%（走 raw） | `public/wasm-zstd.wasm` 缺失，worker fetch 404 | 重跑 `npm run build`（触发 `prebuild`→prepare-wasm） |
| 跨工程 import 报 `@/options` 找不到 | Vite alias 未生效 | 确认 `vite.config.ts` 的 `resolve.alias` 含 `{ find: "@/", replacement: ".../sender/src/" }` |
