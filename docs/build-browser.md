# 浏览器扩展构建说明 (Browser Extension Build)

## 前置条件

- Node.js ≥ 18
- npm（或 pnpm）
- Rust + wasm-pack（见 [开发环境搭建](dev-setup.md)）

## 构建 WASM 核心

```bash
cd apps/sender
npm run wasm
```

此命令编译 `core/transfer-engine` 为 WebAssembly 并输出到 `wasm-pkg/`。

## 构建扩展

### 全部目标（推荐）

```bash
cd apps/sender
npm run build
```

一次性构建全部 4 个目标：

| 目标 | 产物目录 | 支持浏览器 |
|------|---------|-----------|
| `chrome-mv3-prod` | Chrome / Edge（MV3） | Chrome 88+, Edge 88+ |
| `chrome-mv2-prod` | Chrome / Edge（MV2 遗留） | 旧版 Chrome / Edge |
| `firefox-mv3-prod` | Firefox（MV3） | Firefox 109+ |
| `firefox-mv2-prod` | Firefox（MV2 遗留） | Firefox 91+ |

### 单独构建某个目标

```bash
npm run build:chrome-mv3    # Chrome / Edge MV3
npm run build:chrome-mv2    # Chrome / Edge MV2
npm run build:firefox-mv3   # Firefox MV3
npm run build:firefox-mv2   # Firefox MV2
```

### 构建后处理

`scripts/fix-manifest.cjs` 会自动执行以下修正：
- **图标处理**：将 `assets/icon{16,32,48,64,128}.png` 真实 RGBA 图标复制进产物目录，覆盖 Plasmo 生成的 1-bit 占位图，并重写 `icons` / `default_icon` 指向新文件
- MV2：移除无效的 `action` 字段，保留 `browser_action`，并补全 `default_title`
- MV3：补全 `action.default_title`
- MV2：CSP 改为 `wasm-eval`（MV3 的 `wasm-unsafe-eval` 在 MV2 中不支持）
- Firefox：添加 `browser_specific_settings.gecko.id`（`airferry@airferry.app`）
- 修补 HTML `<title>` 标签为「易传 · 文件传输」

### 打包发布产物

构建完成后，将各产物目录打包为可分发的 `.crx` / `.xpi`：

```bash
# Chrome / Edge：用 Chrome + 私钥生成签名 CRX（Cr24 格式）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension=build/chrome-mv3-prod \
  --pack-extension-key=dist/airferry-extension.pem
# 产出 build/chrome-mv3-prod.crx

# Firefox：直接 zip 打包为 XPI
cd build/firefox-mv3-prod && zip -r -X ../airferry-firefox-mv3-v1.0.0.xpi .
```

> 私钥 `dist/airferry-extension.pem` 为 PKCS#8 格式，决定扩展 ID。同一私钥打包 MV2/MV3 会得到相同的扩展 ID（`nboajkjpabbekenmadidokmefholfmfk`），便于升级替换。

## 开发模式

```bash
npm run dev
```

Plasmo 启动 HMR 开发服务器，自动重载扩展。

## 加载到浏览器

### Chrome / Edge

1. 打开 `chrome://extensions`（或 `edge://extensions`）
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `build/chrome-mv3-prod/`（或 `build/chrome-mv2-prod/`）目录

### Firefox

1. 打开 `about:debugging#/runtime/this-firefox`
2. 点击「临时载入附加组件」
3. 选择 `build/firefox-mv3-prod/manifest.json`（或 MV2）

### 使用

1. 点击工具栏易传图标 → 弹出窗口
2. 点击「开始发送文件」→ 在新标签页打开完整应用
3. 选择文件 → 设置参数 → 开始播放二维码视频流

## 项目结构

```
apps/sender/
├── package.json
├── tsconfig.json
├── scripts/
│   ├── build-all.cjs           # 全量构建脚本（4 目标）
│   ├── fix-manifest.cjs        # MV2/Firefox manifest 修正
│   └── extract-lzma-wasm.cjs   # lzma-wasm base64 → .wasm 提取
├── src/
│   ├── popup.tsx               # 工具栏弹出窗口
│   ├── options.tsx             # 完整应用（4 页面路由）
│   ├── pages/                  # 4 个页面组件
│   │   ├── FileSelectPage.tsx
│   │   ├── ParamsPage.tsx
│   │   ├── PlayPage.tsx
│   │   └── StatsPage.tsx
│   ├── components/
│   │   └── QrStream.tsx        # QR 视频流渲染器
│   ├── wasm/
│   │   ├── loader.ts           # WASM 加载
│   │   ├── compress.ts         # 三算法选优压缩
│   │   ├── crc32.ts            # CRC32 计算
│   │   └── session.ts          # 会话 ID 派生
│   ├── types.ts                # 共享类型
│   └── assets/
│       └── app.css             # 样式
├── wasm-pkg/                   # wasm-pack 产物（generated）
└── assets/                     # 图标
```
