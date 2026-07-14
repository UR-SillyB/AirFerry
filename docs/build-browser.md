# 浏览器扩展构建说明 (Browser Extension Build)

## 前置条件

- Node.js ≥ 18
- npm（或 pnpm）
- Rust + wasm-pack（见 [开发环境搭建](dev-setup.md)）
- 打包发布产物（可选）：macOS 上安装的 Google Chrome，用于签名 `.crx`

## 构建 WASM 核心（双产物）

```bash
cd apps/sender
npm run wasm
```

此命令（`scripts/build-wasm.cjs`）编译 `core/transfer-engine` 为 WebAssembly **两份产物**：

| 产物目录 | wasm-bindgen 版本 | 特性 | 供哪个目标 |
|---------|------------------|------|-----------|
| `wasm-pkg-legacy/` | `=0.2.92`（默认锁定） | 标量、无 externref（Chrome 87+ 可加载） | MV2（`chrome-mv2` / `firefox-mv2`） |
| `wasm-pkg-simd/` | `=0.2.125`（脚本临时升级） | `+simd128` SIMD + externref（Chrome 96+ / FF 116+） | MV3（`chrome-mv3` / `firefox-mv3`） |

> **Cargo 文件还原**：构建 MV3 时脚本临时改写 `core/transfer-engine/Cargo.toml` 的 wasm-bindgen 版本到 0.2.125，并重算 workspace lockfile。脚本启动时已按字节快照 Cargo.toml/Cargo.lock，构建完在 `finally` 中逐字节恢复；不调用 `git checkout`，因此不会丢失运行前已有的未提交修改。详见 `apps/sender/scripts/build-wasm.cjs`。

> **关于 SIMD 提速的实测结论**：`+simd128` 对当前纯标量的 `raptorq` crate **无性能收益**（实测 0.95×，反而因 wasm 变大略慢）；QR 编码现用 `fast_qr` crate（已替代旧 `qrcode`，Reed-Solomon 路径 ~7-9× 提速），同样无 wasm32 SIMD intrinsics。双产物机制的真实价值是「MV2 兼容老 Chrome（无 externref）+ MV3 用新工具链」的兼容性分离，并为未来引入 SIMD 化的库保留构建基础设施。详见 `AGENTS.md` §5 第6条。

> `npm run build` 已内嵌此步骤，通常无需单独跑 `npm run wasm`。

## 构建扩展

### 全部目标（推荐）

```bash
cd apps/sender
npm run build
```

一次性构建全部 4 个目标，产物在 `apps/sender/build/`：

| 目标目录 | 支持浏览器 |
|---------|-----------|
| `chrome-mv3-prod` | Chrome / Edge（MV3，Chrome 88+ / Edge 88+） |
| `chrome-mv2-prod` | Chrome / Edge（MV2 遗留，旧版浏览器） |
| `firefox-mv3-prod` | Firefox（MV3，Firefox 109+） |
| `firefox-mv2-prod` | Firefox（MV2 遗留，Firefox 91+） |

### 单独构建某个目标

```bash
npm run build:chrome-mv3    # Chrome / Edge MV3
npm run build:chrome-mv2    # Chrome / Edge MV2
npm run build:firefox-mv3   # Firefox MV3
npm run build:firefox-mv2   # Firefox MV2
```

每个目标的 build 脚本（见 `package.json`）链式完成：`extract-lzma-wasm` → `plasmo build --target=…` → `fix-manifest.cjs` → 复制 `wasm-zstd.wasm` 进产物目录。

### 构建后处理

`scripts/fix-manifest.cjs` 会自动执行以下修正：

- **图标处理**：将 `assets/icon{16,32,48,64,128}.png` 真实 RGBA 图标复制进产物目录，覆盖 Plasmo 生成的 1-bit 占位图，并重写 `icons` / `default_icon` 指向新文件
- MV2：移除无效的 `action` 字段，保留 `browser_action`，并补全 `default_title`
- MV3：补全 `action.default_title`
- MV2：CSP 改为 `wasm-eval`（MV3 的 `wasm-unsafe-eval` 在 MV2 中不支持）
- Firefox：添加 `browser_specific_settings.gecko.id`（`airferry@airferry.app`）
- 修补 HTML `<title>` 标签为「AirFerry · 无网文件传输」

## 打包发布产物

构建 + 打包由根目录的一键脚本完成，版本号取自 `apps/sender/package.json`：

```bash
# 构建 + 打包到 dist/（含 crx/xpi 签名）
./scripts/build-all.sh release

# 或仅打包（apps/sender/build/ 与 APK 已构建好）
./scripts/build-all.sh dist
```

产物（`dist/`，均 git-ignored，通过 GitHub Release 分发）：

| 产物 | 说明 |
|------|------|
| `airferry-sender-chrome-mv3-v<VER>.crx` | Chrome/Edge MV3（已签名 Cr24） |
| `airferry-sender-chrome-mv3-v<VER>.zip` | Chrome/Edge MV3（解压加载回退） |
| `airferry-sender-chrome-mv2-v<VER>.crx` | Chrome/Edge MV2（已签名 Cr24） |
| `airferry-sender-chrome-mv2-v<VER>.zip` | Chrome/Edge MV2（解压加载回退） |
| `airferry-sender-firefox-mv3-v<VER>.xpi` | Firefox MV3（zip→xpi） |
| `airferry-sender-firefox-mv2-v<VER>.xpi` | Firefox MV2（zip→xpi） |
| `airferry-extension.pem` | Chrome 签名私钥（首次自动生成，git-ignored） |

### Chrome crx 签名机制

脚本调用 Chrome 的 `--pack-extension` 生成 Cr24 签名：

- **首次**（无 `dist/airferry-extension.pem`）：Chrome 新生成私钥，脚本把它挪到 `dist/airferry-extension.pem`
- **后续**：用 `--pack-extension-key` 复用同一私钥 → MV2/MV3 得到**相同的扩展 ID**，便于升级替换
- **找不到 Chrome**（如 Linux/CI）：warn 并跳过 crx，仅保留 `.zip`（此时用「加载已解压的扩展程序」安装）

> 私钥决定扩展 ID，**务必妥善保管 `dist/airferry-extension.pem`**；丢失后无法再为同一扩展 ID 签名。

### Firefox xpi 说明

`.xpi` 本质是 zip（固定扩展名），脚本直接 zip 打包后改名。注意发布的 `.xpi` **未经 Mozilla 签名**（Mozilla 不支持纯本地签名，需经 AMO 服务签名），因此普通 Firefox 正式版会拒绝安装。可行方案见 [README → Firefox 扩展](../README.md#firefox-扩展)（Developer/Nightly 关闭签名校验、临时载入、或上传 AMO 签名后分发）。

## 开发模式

```bash
npm run dev
```

Plasmo 启动 HMR 开发服务器，自动重载扩展。

## 加载到浏览器

### Chrome / Edge

1. 打开 `chrome://extensions`（或 `edge://extensions`）
2. 开启「开发者模式」
3. 二选一：
   - 拖入已签名的 `.crx`
   - 解压 `.zip` 后点「加载已解压的扩展程序」并选择 `chrome-mv3-prod/`（或 mv2）目录；也可直接用 `apps/sender/build/chrome-mv3-prod/`

### Firefox

1. 打开 `about:debugging#/runtime/this-firefox`
2. 点击「临时载入附加组件」
3. 选择 `build/firefox-mv3-prod/manifest.json`（或 MV2），或拖入 `.xpi`

> 因未签名，正式版 Firefox 拒绝安装 `.xpi`；需 Developer/Nightly 关闭 `xpinstall.signatures.required` 或走临时载入（详见 README）。

### 使用

1. 点击工具栏 AirFerry 图标 → 弹出窗口
2. 点击「开始发送文件」→ 在新标签页打开完整应用
3. 选择文件（≥2 自动打包）→ 选速度预设 / 调参数 → 开始播放二维码视频流

## 项目结构

```
apps/sender/
├── package.json                # 依赖 + manifest + 各目标 build 脚本
├── tsconfig.json
├── pnpm-workspace.yaml         # 允许构建的原生依赖白名单
├── scripts/
│   ├── build-all.cjs           # 全量构建脚本（4 目标）
│   ├── fix-manifest.cjs        # MV2/Firefox manifest + 图标修正
│   └── extract-lzma-wasm.cjs   # lzma-wasm base64 → .wasm 提取
├── src/
│   ├── popup.tsx               # 工具栏弹出窗口
│   ├── options.tsx             # 完整应用（4 页面路由 + Worker 调度）
│   ├── types.ts                # 共享类型 + 速度预设 + DEFAULT_CONFIG
│   ├── pages/                  # 4 个页面组件
│   │   ├── FileSelectPage.tsx
│   │   ├── ParamsPage.tsx
│   │   ├── PlayPage.tsx
│   │   └── StatsPage.tsx
│   ├── components/
│   │   ├── QrStream.tsx        # QR 视频流渲染器（单码/4码 + 抖动）
│   │   └── CompressProgress.tsx# 压缩阶段进度遮罩
│   ├── workers/
│   │   └── compress.worker.ts  # 离线压缩/打包/CRC/指纹/会话ID（主线程不卡）
│   ├── wasm/
│   │   ├── loader.ts           # WASM 加载
│   │   ├── bundle.ts           # 多文件打包（ETBUNDL1 容器）
│   │   ├── compress.ts         # 三算法选优压缩（Zstd Lv1 / Xz Lv9 / Raw）
│   │   ├── crc32.ts            # CRC32 计算
│   │   └── session.ts          # 会话 ID 派生（FNV-1a 128）
│   └── assets/
│       └── app.css             # 样式
├── wasm-pkg-legacy/            # wasm-pack 产物（generated，MV2 用，标量+0.2.92）
├── wasm-pkg-simd/              # wasm-pack 产物（generated，MV3 用，SIMD+0.2.125）
└── assets/                     # 图标（icon{16,32,48,64,128}.png）
```
