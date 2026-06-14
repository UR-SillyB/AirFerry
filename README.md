# EasyTransfer

> 完全离线的光学文件传输系统 · Fully Offline Optical File Transfer

通过**屏幕二维码视频流 + 手机摄像头扫描**完成文件传输，不依赖互联网、局域网、蓝牙、USB、NFC 等任何通信通道。适用于 Air-Gap（隔离网络）场景。

- **发送端**：Chrome / Edge 浏览器扩展（Manifest V3）
- **接收端**：Android 原生 App
- **核心库**：Rust，同时编译为 **WebAssembly**（浏览器插件）与 **Android Native Library**（JNI 调用），保证两端编解码逻辑完全一致

## 数据流

```
发送端                                          接收端
文件                                             摄像头视频流
  │ Zstd 压缩                                     │
  ├─ 分块                                         │
  ├─ RaptorQ 编码 (RFC 6330)                      │
  ├─ QR 帧生成 ───────── 屏幕二维码视频流 ────────► QR 解码 (ZXing-C++)
  └─ 连续播放                                       ├─ RaptorQ 恢复
                                                   ├─ 文件重组
                                                   └─ 文件保存
```

## 特性

- ✅ 高可靠性、高容错率（支持高丢帧 / 乱序 / 重复帧 / 部分损坏）
- ✅ 支持大文件传输
- ✅ 断点恢复（接收端状态持久化，同会话 ID 续传）
- ✅ 连续二维码视频流（30 / 60 fps）
- ✅ Air-Gap 场景，零网络依赖
- ✅ 单向信道，无需回传确认

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
└── docs/                  # 协议 / 架构 / API / 构建说明
```

## 快速开始

详见 [docs/dev-setup.md](docs/dev-setup.md)。各端构建说明：
- 核心库：`cargo build` / `cargo test`
- 浏览器扩展：见 [docs/build-browser.md](docs/build-browser.md)
- Android App：见 [docs/build-android.md](docs/build-android.md)

## 协议规范

见 [docs/protocol.md](docs/protocol.md) 与 [docs/qr-frame-format.md](docs/qr-frame-format.md)。

## 许可证

MIT
