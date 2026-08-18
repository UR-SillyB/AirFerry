# AirFerry

> 完全离线的光学文件传输系统 · Fully Offline Optical File Transfer

通过**屏幕二维码视频流 + 手机摄像头扫描**完成文件传输，不依赖互联网、局域网、蓝牙、USB、NFC 等任何通信通道。适用于 Air-Gap（隔离网络）场景。

> 🤖 **AI 代理/新开发者**：先读 [AGENTS.md](AGENTS.md)（构建命令、代码导航、核心协议与工程不变量）。跨端线格式的位级权威定义见 [docs/SPEC.md](docs/SPEC.md)。

- **发送端**：浏览器扩展（Chrome / Edge / Firefox，支持 MV2 与 MV3）· **网页端**（[在线版](#网页端-web-发送接收)）
- **接收端**：Android 原生 App · Windows 桌面应用（WPF）· **网页接收端**（[在线版](#网页端-web-发送接收)）
- **核心库**：Rust，同时编译为 **WebAssembly**（浏览器插件）、**Android Native Library**（JNI）、**Windows DLL**（C ABI，P/Invoke），保证三端编解码逻辑完全一致

## 数据流

发送端：文件/文字 → 三算法选优压缩（Raw / Zstd / XZ）→ RaptorQ 编码（RFC 6330，源符号一遍 → 持续新鲜修复符号）→ QR 帧 → 屏幕视频流。接收端：摄像头采集 → 并行 QR 解码（ZXing-C++）→ 串行 RaptorQ 摄入/恢复 → 解压 → 文件保存。详图见 [docs/architecture.md](docs/architecture.md#数据流)。

## 特性

- ✅ 高可靠性、高容错率（支持高丢帧 / 乱序 / 重复帧 / 部分损坏）
- ✅ 支持大文件 chunk 化传输（默认 8 MiB 定长切块、逐块三算法选优压缩；文件/多文件包/文字均可）
- ✅ 持续新鲜喷泉码：源符号发一遍后持续补充不重复修复符号，进度近似线性；到 RFC 24 位 ESI 上限时明确停止
- ✅ 接收端并行解码池：多线程 ZXing + 串行原生摄入，吃满高帧率采集
- ✅ 大文件断续恢复（已完成 chunk 跨重启持久化；丢失 chunk 由后续新鲜修复符号补齐）
- ✅ 连续二维码视频流（多档帧率可选，含无限制模式）
- ✅ Air-Gap 场景，零网络依赖
- ✅ 单向信道，无需回传确认
- ✅ 三算法选优压缩（Raw / Zstd Lv1 / Xz Lv9），自动选取最小结果
- ✅ 多文件与多 Entry 结构化传输（统一 Manifest 索引与 Entry 清单）
- ✅ 文件与文字混发（统一选择列表；文件/文件夹支持全页拖放；文字可直接展示与复制）
- ✅ 文本类文件（txt/md）收端可复制 / 分享 / 存盘
- ✅ 4 码并行模式（同帧 tile 4 个不同符号，吞吐 ~4×，默认开启）
- ✅ 速度预设多档可调（符号大小 T = 512 / 896 / 1008 / 1400 / 1904 / 2400）
- ✅ 多浏览器支持（Chrome / Edge / Firefox，MV2 + MV3）
- ✅ 多接收端：网页、Android App 与 Windows 应用复用同一 Rust 协议核心；Windows 支持摄像头 + USB/HDMI/SDI 采集卡 + 屏幕区域/独立窗口捕获（同机或虚拟机/远程桌面场景免摄像头），网页接收端支持屏幕/标签页捕获
- ✅ Windows 持续接收模式：完成后不跳转结果页、不停扫，文件直写指定文件夹；按内容 SHA-256 去重，跳过前复验落盘字节

## 网页端（Web 发送 / 接收）

无需安装，浏览器直接打开（GitHub Pages 自动构建部署）：

| 入口 | 地址 | 说明 |
|------|------|------|
| **网页发送端** | <https://UR-SillyB.github.io/AirFerry/> | 在浏览器里播放二维码视频流发送文件 |
| **网页接收端** | <https://UR-SillyB.github.io/AirFerry/receiver/> | 用摄像头扫码恢复文件 |

> ⚠️ **网页接收端**必须运行在 **HTTPS / localhost** 下才能访问摄像头（浏览器硬性安全限制）；GitHub Pages 天然是 HTTPS，直接可用。因浏览器摄像头管道 + JS/WASM 解码限制，**网页端速度低于原生端**，追求满速、稳定的大文件恢复请优先用 Android / Windows 原生接收端（见下方下载）。

## 下载安装

最新版本发布在 [GitHub Release v1.2.7](https://github.com/UR-SillyB/AirFerry/releases/tag/v1.2.7)。

| 文件 | 说明 |
|------|------|
| `airferry-sender-chrome-mv3-v1.2.7.crx` | Chrome / Edge 浏览器扩展，MV3（现代版），已签名，拖入即可安装 |
| `airferry-sender-chrome-mv3-v1.2.7.zip` | 同上解压加载版（`.crx` 被拦截时用「加载已解压的扩展程序」） |
| `airferry-sender-chrome-mv2-v1.2.7.crx` | Chrome / Edge MV2，旧版浏览器兼容 |
| `airferry-sender-chrome-mv2-v1.2.7.zip` | 同上解压加载版 |
| `airferry-sender-firefox-mv3-v1.2.7.xpi` | Firefox 扩展，MV3（Firefox 116+） |
| `airferry-sender-firefox-mv2-v1.2.7.xpi` | Firefox 91+ 的 MV2 兼容版 |
| `airferry-sender-web-v1.2.7.zip` | 网页发送端静态站点，部署到任意静态托管（官方在线版见[网页端](#网页端web-发送--接收)） |
| `airferry-sender-web-standalone-v1.2.7.html` | 网页发送端单文件版（约 2MB，双击即用，无需服务器） |
| `airferry-receiver-web-v1.2.7.zip` | **网页接收端**：需部署到 HTTPS / localhost 后使用摄像头（官方在线版见[网页端](#网页端web-发送--接收)） |
| `airferry-receiver-android-arm64-v1.2.7.apk` | **Android 扫码端**：arm64-v8a，Android 10+，对准屏幕二维码即可接收 |
| `airferry-receiver-windows-x64-v1.2.7.zip` | **Windows 扫码端**：x64，Windows 10+，视频源支持摄像头 + USB/HDMI/SDI 采集卡 + 屏幕区域/窗口捕获 |

> 发送端/APK/web 由 `./scripts/build-all.sh release` 产出；版本号取自根 `Cargo.toml`（`[workspace.package].version`），由 `node scripts/version.mjs check` 门禁统一各端。Windows zip 默认由 GitHub Actions `windows` workflow（`workflow_dispatch`）上传到同一 Release。Chrome `.crx` 需本机有 Chrome 才能签名，否则仅产出 `.zip`。web 发送端/接收端由 GitHub Actions `pages` workflow 自动构建并部署到 GitHub Pages（推送 `main` 即触发）。

### Android 接收端

下载 APK，允许「未知来源」后安装到 Android 10+ 设备（已用 release keystore 签名）。

### Windows 接收端

解压 `airferry-receiver-windows-x64-v1.2.7.zip`，安装 [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0) 后运行 `AirFerry.exe`。启动后在同一个「扫描来源」单选列表中选择摄像头、采集卡或屏幕捕获（彼此互斥，USB/HDMI/SDI 采集卡会被自动标注），再点统一的主按钮开始。选择「屏幕捕获」时会打开截图式选择器，可把**屏幕矩形区域**（拖动）或**某个窗口**（单击，悬停自动高亮）作为视频源；**右键= 快速选择整个屏幕**（全屏应用/游戏首选——无边框游戏会因焦点被抢而最小化、独占全屏无法按窗口捕获）——适合同机浏览器播放二维码做端到端测试、虚拟机/远程桌面窗口等无摄像头场景，Esc 取消。进入扫码页对准屏幕二维码即可。

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

1. 下载对应 `.xpi` 文件（MV3 为 Firefox 116+，MV2 为 Firefox 91+）
2. 打开 `about:addons` → 齿轮图标 → 「Install Add-on From File」选择 `.xpi`
3. 或在 `about:debugging#/runtime/this-firefox` 中「Load Temporary Add-on」临时载入

## 仓库结构

```
AirFerry/
├── core/                  # 跨端 Rust 协议核心 + ZXing-C++ 相机解码核心
│   ├── af2/               # AF2 核心协议层（帧格式、三层 ID、Manifest、状态机、Playlist）
│   ├── raptorq-core/      # RFC 6330 RaptorQ 编解码封装
│   ├── qr-protocol/       # 压缩 / CRC / QR 矩阵
│   ├── transfer-engine/   # 编排 / 状态机 / 进度 / 快照 + WASM/JNI/C ABI
│   └── zxing-decoder/     # ZXing-C++ 的 WASM / Windows 解码封装
├── apps/
│   ├── web/               # Vite + React + TS + WASM 前端（浏览器扩展 + 网页发送/接收 + 单文件版）
│   ├── scanner/           # Kotlin + CameraX + ZXing-C++ 接收端（Android App）
│   └── windows/           # C# WPF + OpenCvSharp + ZXing-C++（Windows App）
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
| Windows App | `./scripts/build-windows.ps1` | 须 Windows + .NET 8 SDK + CMake/VS C++（详见 [docs/build-windows.md](docs/build-windows.md)） |

## 技术架构

RaptorQ 喷泉码（RFC 6330）+ 三算法选优压缩 + 最小版本 EC-L 二维码 + 周期广播 ROOT 与 OBJECT_META；Android/Windows 接收端镜像同一套并行解码、串行摄入管线。详见 [docs/architecture.md](docs/architecture.md) 与 [docs/SPEC.md](docs/SPEC.md)。

## 文档

- [AGENTS.md](AGENTS.md) — 🤖 AI 代理操作手册（构建命令、代码导航、工程不变量）
- [跨端契约规格](docs/SPEC.md) — AF2 位级权威定义与线格式
- [架构设计](docs/architecture.md) — 系统架构、数据流与容错设计
- [API 参考](docs/api.md) — 核心 API 文档
- [构建指南 - 浏览器扩展与网页端](docs/build-web-targets.md)
- [构建指南 - Android](docs/build-android.md)
- [构建指南 - Windows](docs/build-windows.md)
- [开发环境搭建](docs/dev-setup.md)
- [变更记录](CHANGELOG.md)

## 致谢

- [RaptorQR](https://github.com/infrost/RaptorQR)（MIT，© 2026 Haixiang）— 同样基于 Rust→WASM RaptorQ 喷泉码管线与并行二维码播放的离线光学传输工具。AirFerry 在「Rust 核心编译到 WASM + 浏览器二维码视频流」这一架构方向上参考了它的先行探索。
- [cberner/raptorq](https://github.com/cberner/raptorq) — 本项目核心依赖的 RFC 6330 RaptorQ Rust 实现。

## 友情链接

- [linux.do](https://linux.do) — 真诚、友善、实用的开源技术社区

## 许可证

MIT
