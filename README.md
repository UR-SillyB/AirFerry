# AirFerry

> 完全离线的光学文件传输系统 · Fully Offline Optical File Transfer

通过**屏幕二维码视频流 + 手机摄像头扫描**完成文件传输，不依赖互联网、局域网、蓝牙、USB、NFC 等任何通信通道。适用于 Air-Gap（隔离网络）场景。

> 🤖 **AI 代理/新开发者**：先读 [AGENTS.md](AGENTS.md)（构建命令、代码导航、调试速查、文档与代码偏差清单）。跨端线格式的位级权威定义见 [docs/SPEC.md](docs/SPEC.md)。

- **发送端**：浏览器扩展（Chrome / Edge / Firefox，支持 MV2 与 MV3）· **网页端**（[在线版](#网页端-web-发送接收)）· **Python 文件转视频包**（[使用与构建](docs/build-python.md)，尚未发布 PyPI）
- **接收端**：Android 原生 App · Windows 桌面应用（WPF）· **网页接收端**（[在线版](#网页端-web-发送接收)）
- **核心库**：Rust，提供 **WebAssembly**（浏览器插件）、**Android Native Library**（JNI）、**Windows DLL**（C ABI，P/Invoke）和 **Python 扩展**（PyO3），复用同一套编解码逻辑

## 数据流

```
发送端                                          接收端
文件                                             摄像头视频流 (锁 ~60fps)
  │ 三算法选优压缩 (Raw / Zstd / XZ)              │
  ├─ 分块                                         │
  ├─ RaptorQ 编码 (RFC 6330)                      │
  ├─ QR 帧生成 (源一遍→持续新鲜修复) ── 视频流 ──► 并行 QR 解码 (N×ZXing-C++)
  └─ 连续播放 (15/20/30/45/60/90/120fps或无限制, 默认 60) ├─ 串行 RaptorQ 摄入/恢复
                                                   ├─ 解压缩
                                                   ├─ 文件重组
                                                   └─ 文件保存
```

## 特性

- ✅ 高可靠性、高容错率（支持高丢帧 / 乱序 / 重复帧 / 部分损坏）
- ✅ 支持大文件分段传输（整段压缩后按 ~32 MiB 切压缩流段；文件/多文件包/文字均可）
- ✅ 持续新鲜喷泉码：源符号发一遍后持续补充不重复修复符号，进度近似线性；到 RFC 24 位 ESI 上限时明确停止
- ✅ 接收端并行解码池：多线程 ZXing + 串行原生摄入，吃满高帧率采集
- ✅ 大文件断点恢复（历史页显示缺失段；已校验完成段跨重启保留）
- ✅ 连续二维码视频流（15 / 20 / 30 / 45 / 60 / 90 / 120 fps 或无限制，默认 60）
- ✅ Air-Gap 场景，零网络依赖
- ✅ 单向信道，无需回传确认
- ✅ 三算法选优压缩（Raw / Zstd Lv1 / Xz Lv9），自动选取最小结果
- ✅ 多文件打包传输（≥2 项自动打包成单个 ETBUNDL1 容器，走同一条二维码流）
- ✅ 文件与文字混发（统一选择列表；文件/文件夹支持全页拖放；单条纯文字仍为 ETTEXTv1，收端可复制）
- ✅ 文本类文件（txt/md/json/源码等）收端可复制 / 分享 / 存盘
- ✅ 4 码并行模式（同帧 tile 4 个不同符号，吞吐 ~4×，默认开启）
- ✅ 速度预设（稳定 / 高速 / 极限 / 激进 / 极速 / 极限 2400B，默认激进 1400B@60fps）
- ✅ 多浏览器支持（Chrome / Edge / Firefox，MV2 + MV3）
- ✅ 多接收端：网页、Android App 与 Windows 应用复用同一 Rust 协议核心；Windows 支持摄像头 + USB/HDMI/SDI 采集卡 + 屏幕区域/独立窗口捕获（同机或虚拟机/远程桌面场景免摄像头）

## 网页端（Web 发送 / 接收）

无需安装，浏览器直接打开（GitHub Pages 自动构建部署）：

| 入口 | 地址 | 说明 |
|------|------|------|
| **网页发送端** | <https://UR-SillyB.github.io/AirFerry/> | 在浏览器里播放二维码视频流发送文件 |
| **网页接收端** | <https://UR-SillyB.github.io/AirFerry/receiver/> | 用摄像头扫码恢复文件 |

> ⚠️ **网页接收端**必须运行在 **HTTPS / localhost** 下才能访问摄像头（浏览器硬性安全限制）；GitHub Pages 天然是 HTTPS，直接可用。因浏览器摄像头管道 + JS/WASM 解码限制，**网页端速度低于原生端**，追求满速、稳定的大文件恢复请优先用 Android / Windows 原生接收端（见下方下载）。

## 下载安装

最新版本发布在 [GitHub Release v1.2.8](https://github.com/UR-SillyB/AirFerry/releases/tag/v1.2.8)。

| 文件 | 说明 |
|------|------|
| `airferry-sender-chrome-mv3-v1.2.8.crx` / `.zip` | Chrome / Edge MV3 现代标量版；CRX 使用固定发布密钥签名，受策略限制时改用 zip 解压加载 |
| `airferry-sender-chrome-mv2-v1.2.8.crx` / `.zip` | Chrome / Edge MV2 旧版兼容标量版；CRX 使用同一固定发布密钥签名 |
| `airferry-sender-firefox-mv3-v1.2.8.xpi` | Firefox 扩展，MV3（Firefox 116+） |
| `airferry-sender-firefox-mv2-v1.2.8.xpi` | Firefox 91+ 的 MV2 兼容版 |
| `airferry-sender-web-v1.2.8.zip` | 网页发送端静态站点，现代标量 WASM，部署到任意静态托管（官方在线版见[网页端](#网页端web-发送--接收)） |
| `airferry-sender-web-standalone-v1.2.8.html` | 网页发送端单文件版（约 2MB，双击即用，无需服务器） |
| `airferry-receiver-web-v1.2.8.zip` | **网页接收端**：需部署到 HTTPS / localhost 后使用摄像头（官方在线版见[网页端](#网页端web-发送--接收)） |
| `airferry-receiver-android-arm64-v1.2.8.apk` | **Android 扫码端**：arm64-v8a，Android 10+，使用固定 release keystore 签名 |
| `airferry-receiver-windows-x64-v1.2.8.zip` | **Windows 扫码端**：x64，Windows 10+，视频源支持摄像头 + USB/HDMI/SDI 采集卡 + 屏幕区域/窗口捕获 |

> 发送端/APK/web 由 `./scripts/build-all.sh release` 产出；版本号取自 `apps/sender/package.json`。Windows zip 默认由 GitHub Actions `windows` workflow（`workflow_dispatch`）上传到同一 Release。Chrome `.crx` 需本机有 Chrome 才能签名，否则仅产出 `.zip`。web 发送端/接收端由 GitHub Actions `pages` workflow 自动构建并部署到 GitHub Pages（推送 `main` 即触发）。

### Python 文件转视频

Python 包独立版本为 `0.1.0`，目前从完整仓库安装，尚未发布 PyPI：

```bash
python -m pip install ./apps/python
```

```python
from airferry import file_to_video

file_to_video("report.pdf", "report.mp4")
```

也可使用 `airferry report.pdf report.mp4 --qr-count 4`。安装完成后，压缩和视频编码使用 Rust 核心与本机 FFmpeg，无运行期组件下载、遥测或在线服务。文件可位于普通磁盘、UNC、映射盘或 NFS 等文件系统，支持 `file://` URL；网络存储按正常文件 I/O 访问。支持大文件分段。源码安装需要 Rust/C 构建工具，离线 wheel 安装与完整接口见[Python 构建指南](docs/build-python.md)。

### Android 接收端

下载 APK，允许「未知来源」后安装到 Android 10+ 设备（已用 release keystore 签名）。

### Windows 接收端

解压 `airferry-receiver-windows-x64-v1.2.8.zip`，安装 [.NET 8 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/8.0) 后运行 `AirFerry.exe`。启动后在同一个「扫描来源」单选列表中选择摄像头、采集卡或屏幕捕获（彼此互斥，USB/HDMI/SDI 采集卡会被自动标注），再点统一的主按钮开始。选择「屏幕捕获」时会打开截图式选择器，可把**屏幕矩形区域**（拖动）或**某个窗口**（单击，悬停自动高亮）作为视频源；**右键= 快速选择整个屏幕**（全屏应用/游戏首选——无边框游戏会因焦点被抢而最小化、独占全屏无法按窗口捕获）——适合同机浏览器播放二维码做端到端测试、虚拟机/远程桌面窗口等无摄像头场景，Esc 取消。进入扫码页对准屏幕二维码即可。

### Chrome / Edge 扩展

1. 优先下载对应 `.crx`（MV3 为现代标量版，MV2 供旧版浏览器兼容）；若浏览器策略阻止商店外 CRX 安装，则下载同名 `.zip` 并解压
2. 使用 zip 时打开 `chrome://extensions`，右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择解压目录

> v1.2.8 CRX 复用了原固定私钥，MV2/MV3 扩展 ID 均保持为 `lgafjpalpcbiellnlbfdabdlbfooojjm`；zip 作为浏览器阻止商店外 CRX 安装时的回退。

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
├── core/                  # 跨端 Rust 协议核心 + Windows ZXing-C++ 相机解码核心
│   ├── raptorq-core/      # RFC 6330 RaptorQ 编解码封装
│   ├── qr-protocol/       # 帧格式 / 分块 / 压缩 / CRC / QR 矩阵
│   ├── transfer-engine/   # 编排 / 状态机 / 进度 / 断点 + WASM/JNI/C ABI
│   └── zxing-decoder/     # Windows 对 Android v1.1.3 模式的 ZXing-C++ 实现
├── apps/
│   ├── sender/            # Plasmo + React + TS + WASM 发送端（浏览器扩展）
│   ├── scanner/           # Kotlin + CameraX + ZXing-C++ 接收端（Android App）
│   ├── python/            # Python + PyO3 发送端（本地文件 → MP4；独立 PyPI 包）
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
| Python 发送端 | `python -m pip install ./apps/python` | CPython 3.10+；文件转 MP4，详见 [docs/build-python.md](docs/build-python.md) |

## 技术架构

- **编码层**：RaptorQ 喷泉码（RFC 6330）；发送端源符号发一遍后持续补充新鲜修复符号（ESI 单调递增、不重复；上限 2²⁴−1），接收端可随时加入
- **打包层**：≥2 文件先打包成 ETBUNDL1 容器，整批走单条压缩 + 单条 RaptorQ 流
- **压缩层**：三算法选优（Raw / Zstd Lv1 / Xz Lv9），70% Zstd early-exit 启发式跳过慢速 Xz
- **传输层**：60 字节帧头 + symbol_size 负载（浏览器默认 1400）+ 4 字节 CRC，编码为**最小版本** EC-L 二维码（**1464B 帧 → V27 125×125**）；4 码模式同帧 tile 4 个符号、吞吐 ~4×
- **协议层**：Descriptor 帧（每 17 帧，首帧即描述符）携带 OTI + 文件元数据（文件名、大小、CRC32、压缩标签）；17 与 2/4 多码布局互质，使描述符轮流经过所有屏幕码位
- **接收层**：Android 用 CameraX，并固定采用 v1.1.3 的 Kotlin 调度器与 JNI ZXing-C++ 解码路径；Windows 用 OpenCvSharp DirectShow，并通过 `core/zxing-decoder/` 镜像同一套 v1.1.3 全帧/ROI 模式。两端均为 2–6 worker、4 符号批摄入和串行 Rust 摄入。Windows Gray 帧仅池化复制一次，UI 以约 7Hz 展示 3 秒窗口速率和有效吞吐

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
- [构建指南 - Python](docs/build-python.md)
- [开发环境搭建](docs/dev-setup.md)

## 致谢

- [RaptorQR](https://github.com/infrost/RaptorQR)（MIT，© 2026 Haixiang）— 同样基于 Rust→WASM RaptorQ 喷泉码管线与并行二维码播放的离线光学传输工具。AirFerry 在「Rust 核心编译到 WASM + 浏览器二维码视频流」这一架构方向上参考了它的先行探索。
- [cberner/raptorq](https://github.com/cberner/raptorq) — 本项目核心依赖的 RFC 6330 RaptorQ Rust 实现。

## 友情链接

- [linux.do](https://linux.do) — 真诚、友善、实用的开源技术社区

## 许可证

MIT
