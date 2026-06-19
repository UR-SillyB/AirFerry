# 易传 EasyTransfer

> 完全离线的光学文件传输系统 · Fully Offline Optical File Transfer

通过**屏幕二维码视频流 + 手机摄像头扫描**完成文件传输，不依赖互联网、局域网、蓝牙、USB、NFC 等任何通信通道。适用于 Air-Gap（隔离网络）场景。

- **发送端**：浏览器扩展（Chrome / Edge / Firefox，支持 MV2 与 MV3）
- **接收端**：Android 原生 App
- **核心库**：Rust，同时编译为 **WebAssembly**（浏览器插件）与 **Android Native Library**（JNI 调用），保证两端编解码逻辑完全一致

## 数据流

```
发送端                                          接收端
文件                                             摄像头视频流 (锁 ~60fps)
  │ 三算法选优压缩 (Raw / Zstd / XZ)              │
  ├─ 分块                                         │
  ├─ RaptorQ 编码 (RFC 6330)                      │
  ├─ QR 帧生成 (源一遍→无限新鲜修复) ── 视频流 ──► 并行 QR 解码 (N×ZXing-C++)
  └─ 连续播放 (30/45/60fps)                         ├─ 串行 RaptorQ 摄入/恢复
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
- ✅ 三算法选优压缩（Raw / Zstd Lv22 / Xz Lv9），自动选取最小结果
- ✅ 多浏览器支持（Chrome / Edge / Firefox，MV2 + MV3）
- 🧪 实验性：旗舰机高速相机录制（120/240fps）→ 后台批量解码（设置中开启）

## 下载安装

最新版本发布在 [GitHub Release v1.0.0](https://github.com/UR-SillyB/EasyTransfer/releases/tag/v1.0.0)。

| 文件 | 说明 |
|------|------|
| `easytransfer-android-v1.0.0.apk` | Android 接收端（Android 10+，arm64-v8a） |
| `easytransfer-chrome-mv3-v1.0.0.crx` | Chrome / Edge MV3 扩展（已签名 Cr24） |
| `easytransfer-chrome-mv2-v1.0.0.crx` | Chrome / Edge MV2 扩展（旧版兼容，已签名 Cr24） |
| `easytransfer-firefox-mv3-v1.0.0.xpi` | Firefox MV3 扩展（Firefox 109+） |
| `easytransfer-firefox-mv2-v1.0.0.xpi` | Firefox MV2 扩展（Firefox 91+） |

### Android 接收端

下载 APK，允许「未知来源」后安装到 Android 10+ 设备。

### Chrome / Edge 扩展

1. 下载对应 `.crx` 文件（MV3 为现代版本，MV2 供旧版浏览器兼容）
2. 打开 `chrome://extensions`，右上角开启「开发者模式」
3. 将 `.crx` 文件拖入浏览器窗口即可安装；也可将 `.crx` 解压后点击「加载已解压的扩展程序」

> 注：新版 Chrome 可能因商店外安装拦截 `.crx`，此时使用「加载已解压的扩展程序」方式最稳定。

### Firefox 扩展

1. 下载对应 `.xpi` 文件（MV3 为 Firefox 109+，MV2 为 Firefox 91+）
2. 打开 `about:addons` → 齿轮图标 → 「Install Add-on From File」选择 `.xpi`
3. 或在 `about:debugging#/runtime/this-firefox` 中「Load Temporary Add-on」临时载入

## 仓库结构

```
EasyTransfer/
├── crates/
│   ├── raptorq-core/      # RFC 6330 RaptorQ 编解码封装
│   ├── qr-protocol/       # 帧格式 / 分块 / 压缩 / CRC / QR 矩阵
│   └── transfer-engine/   # 编排 / 状态机 / 进度 / 断点 + WASM&JNI 绑定
├── apps/
│   ├── browser-extension/ # Plasmo + React + TS + Vite + WASM 发送端
│   └── android/           # Kotlin + CameraX + ZXing-C++ 接收端
├── docs/                  # 协议 / 架构 / API / 构建说明（中文）
└── Cargo.toml             # Rust workspace 根配置
```

## 快速开始

详见 [开发环境搭建](docs/dev-setup.md)。各端构建说明：

| 组件 | 命令 | 说明 |
|------|------|------|
| 核心库 | `cargo build` / `cargo test` | Rust workspace |
| 浏览器扩展 | `npm run build` | 构建全部 4 个目标 |
| Android App | `./gradlew assembleDebug` | 需要 Android NDK |

## 技术架构

- **编码层**：RaptorQ 喷泉码（RFC 6330）；发送端源符号发一遍后**无限补充新鲜修复符号**（ESI 单调递增、永不重复），接收端可随时加入
- **压缩层**：三算法选优（Raw / Zstd Lv22 / Xz Lv9），95% Zstd early-exit 启发式跳过慢速 Xz
- **传输层**：60 字节帧头 + symbol_size 负载（浏览器默认 512）+ 4 字节 CRC，编码为**最小版本** EC-L 二维码（576B 帧 → V16 81×81）
- **协议层**：Descriptor 帧（每 16 帧，首帧即描述符）携带 OTI + 文件元数据（文件名、大小、CRC32、压缩标签）
- **接收层**：CameraX 锁定 ~60fps → 并行解码池（多线程 ZXing + 中心 ROI 裁剪）→ 串行 JNI 摄入

## 文档

- [协议规范](docs/protocol.md) — 完整协议描述
- [二维码帧格式](docs/qr-frame-format.md) — 帧头字段定义
- [RaptorQ 参数](docs/raptorq-params.md) — 编解码参数说明
- [架构设计](docs/architecture.md) — 系统架构与组件关系
- [数据流](docs/data-flow.md) — 端到端数据流详解
- [API 参考](docs/api.md) — 核心 API 文档
- [构建指南 - 浏览器扩展](docs/build-browser.md)
- [构建指南 - Android](docs/build-android.md)
- [开发环境搭建](docs/dev-setup.md)

## 许可证

MIT
