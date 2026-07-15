# AirFerry

> 完全离线的光学文件传输系统 · Fully Offline Optical File Transfer

通过**屏幕二维码视频流 + 手机摄像头扫描**完成文件传输，不依赖互联网、局域网、蓝牙、USB、NFC 等任何通信通道。适用于 Air-Gap（隔离网络）场景。

> 🤖 **AI 代理/新开发者**：先读 [AGENTS.md](AGENTS.md)（构建命令、代码导航、调试速查、文档与代码偏差清单）。跨端线格式的位级权威定义见 [docs/SPEC.md](docs/SPEC.md)。

- **发送端**：浏览器扩展（Chrome / Edge / Firefox，支持 MV2 与 MV3）
- **接收端**：Android 原生 App · Windows 桌面应用（WPF）
- **核心库**：Rust，同时编译为 **WebAssembly**（浏览器插件）、**Android Native Library**（JNI）、**Windows DLL**（C ABI，P/Invoke），保证三端编解码逻辑完全一致

## 数据流

```
发送端                                          接收端
文件                                             摄像头视频流 (锁 ~60fps)
  │ 三算法选优压缩 (Raw / Zstd / XZ)              │
  ├─ 分块                                         │
  ├─ RaptorQ 编码 (RFC 6330)                      │
  ├─ QR 帧生成 (源一遍→无限新鲜修复) ── 视频流 ──► 并行 QR 解码 (N×ZXing-C++)
  └─ 连续播放 (20/30/45/60fps, 默认 60)              ├─ 串行 RaptorQ 摄入/恢复
                                                   ├─ 解压缩
                                                   ├─ 文件重组
                                                   └─ 文件保存
```

## 特性

- ✅ 高可靠性、高容错率（支持高丢帧 / 乱序 / 重复帧 / 部分损坏）
- ✅ 支持大文件传输
- ✅ 无限新鲜喷泉码：源符号发一遍后持续补充新符号，进度近似线性、无"越往后越慢"
- ✅ 接收端并行解码池：多线程 ZXing + 串行原生摄入，吃满高帧率采集
- ✅ 断点恢复（接收端状态持久化，同会话 ID 续传）
- ✅ 连续二维码视频流（30 / 45 / 60 fps）
- ✅ Air-Gap 场景，零网络依赖
- ✅ 单向信道，无需回传确认
- ✅ 三算法选优压缩（Raw / Zstd Lv1 / Xz Lv9），自动选取最小结果
- ✅ 多文件打包传输（≥2 项自动打包成单个 ETBUNDL1 容器，走同一条二维码流）
- ✅ 文件与文字混发（统一选择列表；单条纯文字仍为 ETTEXTv1，收端可复制）
- ✅ 文本类文件（txt/md/json/源码等）收端可复制 / 分享 / 存盘
- ✅ 4 码并行模式（同帧 tile 4 个不同符号，吞吐 ~4×，默认开启）
- ✅ 速度预设（稳定 / 高速 / 极限 / 激进 / 极速 / 极限 2400B，默认激进 1400B@60fps）
- ✅ 多浏览器支持（Chrome / Edge / Firefox，MV2 + MV3）
- ✅ 多接收端：Android App（CameraX + ZXing-C++）与 Windows 应用（OpenCvSharp + ZXing.Net，支持摄像头 + USB/HDMI/SDI 采集卡）

## 下载安装

最新版本发布在 [GitHub Release v1.1.1](https://github.com/UR-SillyB/AirFerry/releases/tag/v1.1.1)。

| 文件 | 说明 |
|------|------|
| `airferry-android-v1.1.1.apk` | Android 接收端（Android 10+，arm64-v8a） |
| `airferry-windows-x64-v1.1.1.zip` | Windows 接收端（Windows 10+，x64；需 .NET 8 运行时；由 CI `windows.yml` 打包） |
| `airferry-sender-chrome-mv3-v1.1.1.crx` | Chrome / Edge MV3 扩展（已签名 Cr24） |
| `airferry-sender-chrome-mv3-v1.1.1.zip` | Chrome / Edge MV3（解压加载，crx 被拦截时用） |
| `airferry-sender-chrome-mv2-v1.1.1.crx` | Chrome / Edge MV2 扩展（旧版兼容，已签名 Cr24） |
| `airferry-sender-chrome-mv2-v1.1.1.zip` | Chrome / Edge MV2（解压加载） |
| `airferry-sender-firefox-mv3-v1.1.1.xpi` | Firefox MV3 扩展（Firefox 109+） |
| `airferry-sender-firefox-mv2-v1.1.1.xpi` | Firefox MV2 扩展（Firefox 91+） |
| `airferry-web-v1.1.1.zip` | 网页发送端静态站点 |

> 发送端/APK/web 由 `./scripts/build-all.sh release` 产出；版本号取自 `apps/sender/package.json`。Windows zip 默认由 GitHub Actions `windows` workflow（`workflow_dispatch`）上传到同一 Release。Chrome `.crx` 需本机有 Chrome 才能签名，否则仅产出 `.zip`。

### Android 接收端

下载 APK，允许「未知来源」后安装到 Android 10+ 设备（已用 release keystore 签名）。

### Windows 接收端

解压 `airferry-windows-x64-v1.1.1.zip`，安装 [.NET 8 运行时](https://dotnet.microsoft.com/download/dotnet/8.0) 后运行 `AirFerry.exe`。启动后在设备选择页挑选摄像头或采集卡（USB/HDMI/SDI 采集卡会被自动标注），进入扫码页对准屏幕二维码即可。

### Chrome / Edge 扩展

1. 下载对应 `.crx` 文件（MV3 为现代版本，MV2 供旧版浏览器兼容）
2. 打开 `chrome://extensions`，右上角开启「开发者模式」
3. 将 `.crx` 文件拖入浏览器窗口即可安装；也可下载 `.zip` 解压后点击「加载已解压的扩展程序」并选择解压目录

> 注：新版 Chrome 可能因商店外安装拦截 `.crx`，此时用 `.zip` +「加载已解压的扩展程序」最稳定。

### Firefox 扩展

> 注：发布的 `.xpi` **未经 Mozilla 签名**（Mozilla 不支持纯本地签名，需通过 AMO 服务签名）。因此普通 Firefox 正式版会拒绝安装。可行方案：
> - **Developer / Nightly / ESR 版**：在 `about:config` 中将 `xpinstall.signatures.required` 设为 `false`，再按下方步骤安装；
> - 或将 `.xpi` 解压后用 `about:debugging#/runtime/this-firefox` → 「Load Temporary Add-on」临时载入（重启后失效）；
> - 或将 `.xpi` 上传至 [addons.mozilla.org](https://addons.mozilla.org/developers/) 由 AMO 服务端签名后分发（正式发布推荐）。

1. 下载对应 `.xpi` 文件（MV3 为 Firefox 109+，MV2 为 Firefox 91+）
2. 打开 `about:addons` → 齿轮图标 → 「Install Add-on From File」选择 `.xpi`
3. 或在 `about:debugging#/runtime/this-firefox` 中「Load Temporary Add-on」临时载入

## 仓库结构

```
AirFerry/
├── core/                  # Rust workspace（双端共享核心库）
│   ├── raptorq-core/      # RFC 6330 RaptorQ 编解码封装
│   ├── qr-protocol/       # 帧格式 / 分块 / 压缩 / CRC / QR 矩阵
│   └── transfer-engine/   # 编排 / 状态机 / 进度 / 断点 + WASM&JNI 绑定
├── apps/
│   ├── sender/            # Plasmo + React + TS + WASM 发送端（浏览器扩展）
│   ├── scanner/           # Kotlin + CameraX + ZXing-C++ 接收端（Android App）
│   └── windows/           # C# WPF + OpenCvSharp + ZXing.Net 接收端（Windows App）
├── scripts/
│   ├── build-all.sh       # 一键构建 + 打包（含 crx/xpi 签名，windows 子命令）
│   └── build-windows.ps1  # Windows 端原生 PowerShell 构建脚本（首选）
├── docs/                  # 协议 / 架构 / API / 构建说明（中文）
├── Cargo.toml             # Rust workspace 根配置
└── .gitignore             # dist/ 产物不入库（走 GitHub Release）
```

## 快速开始

详见 [开发环境搭建](docs/dev-setup.md)。各端构建说明：

| 组件 | 命令 | 说明 |
|------|------|------|
| 核心库 | `cargo build` / `cargo test` | Rust workspace |
| 浏览器扩展 | `npm run build` | 构建全部 4 个目标 |
| Android App | `./gradlew assembleDebug` | 需要 Android NDK |
| Windows App | `./scripts/build-windows.ps1` | 须 Windows + .NET 8 SDK（详见 [docs/build-windows.md](docs/build-windows.md)） |

## 技术架构

- **编码层**：RaptorQ 喷泉码（RFC 6330）；发送端源符号发一遍后**无限补充新鲜修复符号**（ESI 单调递增、永不重复），接收端可随时加入
- **打包层**：≥2 文件先打包成 ETBUNDL1 容器，整批走单条压缩 + 单条 RaptorQ 流
- **压缩层**：三算法选优（Raw / Zstd Lv1 / Xz Lv9），70% Zstd early-exit 启发式跳过慢速 Xz
- **传输层**：60 字节帧头 + symbol_size 负载（浏览器默认 1400）+ 4 字节 CRC，编码为**最小版本** EC-L 二维码（**1464B 帧 → V27 125×125**）；4 码模式同帧 tile 4 个符号、吞吐 ~4×
- **协议层**：Descriptor 帧（每 16 帧，首帧即描述符）携带 OTI + 文件元数据（文件名、大小、CRC32、压缩标签）
- **接收层**：Android（CameraX 锁定 ~60fps → 并行解码池 多线程 ZXing-C++ + 中心 ROI 裁剪 → 串行 JNI 摄入）；Windows（OpenCvSharp DirectShow 采集 → 并行解码池 多线程 ZXing.Net → 串行 P/Invoke 摄入）

## 文档

- [AGENTS.md](AGENTS.md) — 🤖 AI 代理操作手册（构建命令、代码导航、调试速查、偏差清单）
- [协议规范](docs/protocol.md) — 完整协议描述
- [跨端契约规格](docs/SPEC.md) — 线格式/会话 ID/JNI 位布局等位级权威定义
- [二维码帧格式](docs/qr-frame-format.md) — 帧头字段定义
- [RaptorQ 参数](docs/raptorq-params.md) — 编解码参数说明
- [架构设计](docs/architecture.md) — 系统架构与组件关系
- [数据流](docs/data-flow.md) — 端到端数据流详解
- [API 参考](docs/api.md) — 核心 API 文档
- [构建指南 - 浏览器扩展](docs/build-browser.md)
- [构建指南 - Android](docs/build-android.md)
- [构建指南 - Windows](docs/build-windows.md)
- [开发环境搭建](docs/dev-setup.md)

## 致谢

- [RaptorQR](https://github.com/infrost/RaptorQR)（MIT，© 2026 Haixiang）— 同样基于 Rust→WASM RaptorQ 喷泉码管线与并行二维码播放的离线光学传输工具。AirFerry 在「Rust 核心编译到 WASM + 浏览器二维码视频流」这一架构方向上参考了它的先行探索。
- [cberner/raptorq](https://github.com/cberner/raptorq) — 本项目核心依赖的 RFC 6330 RaptorQ Rust 实现。

## 友情链接

- [linux.do](https://linux.do) — 真诚、友善、实用的开源技术社区

## 许可证

MIT
