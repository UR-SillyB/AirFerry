# 浏览器扩展构建说明 (Browser Extension Build)

## 前置条件

- Node.js ≥ 18
- npm（或 pnpm）
- Rust + wasm-pack（见 [dev-setup.md](dev-setup.md)）

## 构建 WASM 核心

```bash
cd apps/browser-extension
npm run wasm
```

此命令编译 `crates/transfer-engine` 为 WebAssembly 并输出到 `wasm-pkg/`。

## 构建扩展

```bash
# Chrome (MV3)
npm run build

# Edge (MV3)
npm run build:edge
```

产物：`build/chrome-mv3-prod/`（或 `edge-mv3-prod/`）。

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
4. 选择 `build/chrome-mv3-prod/` 目录

### 使用

1. 点击工具栏 EasyTransfer 图标 → 弹出窗口
2. 点击「打开发送端」→ 在新标签页打开完整应用
3. 选择文件 → 设置参数 → 开始播放二维码视频流

## 打包发布

```bash
npm run package
```

生成可上传到 Chrome Web Store 的 `.zip` 包。

## 项目结构

```
apps/browser-extension/
├── package.json
├── tsconfig.json
├── src/
│   ├── popup.tsx              # 工具栏弹出窗口
│   ├── options.tsx            # 完整应用（4 页面路由）
│   ├── pages/                 # 4 个页面组件
│   │   ├── FileSelectPage.tsx
│   │   ├── ParamsPage.tsx
│   │   ├── PlayPage.tsx
│   │   └── StatsPage.tsx
│   ├── components/
│   │   └── QrStream.tsx       # QR 视频流渲染器
│   ├── wasm/
│   │   ├── loader.ts          # WASM 加载
│   │   ├── compress.ts        # 压缩
│   │   └── session.ts         # 会话 ID 派生
│   ├── types.ts               # 共享类型
│   └── assets/
│       └── app.css            # 样式
├── wasm-pkg/                  # wasm-pack 产物（generated）
└── assets/                    # 图标
```
