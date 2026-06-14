# 系统架构 (Architecture)

## 概述

EasyTransfer 是一个完全离线的光学文件传输系统。发送端（浏览器扩展）将文件编码为二维码视频流在屏幕上连续播放；接收端（Android App）用摄像头实时扫描并恢复文件。两端共享同一套 Rust 核心库，分别编译为 WebAssembly 与 Android Native Library，确保编解码逻辑完全一致。

## 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        发送端 (Browser Extension)                 │
│  Chrome/Edge MV3 · Plasmo + React + TypeScript + Vite            │
│                                                                  │
│  文件 → [fzstd/JS] 压缩 → [Rust/WASM]                           │
│         分块 → RaptorQ 编码 → 帧封装 → QR 矩阵 → Canvas 渲染     │
│                                      │                            │
│                          transfer_engine.wasm (Rust→WASM)        │
└──────────────────────────────────────┬──────────────────────────┘
                                       │ 屏幕二维码视频流 (30/60 fps)
                                       │ (单向光学信道, Air-Gap)
                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                       接收端 (Android App)                        │
│  Kotlin + CameraX + ZXing-C++                                     │
│                                                                  │
│  摄像头视频流 → [ZXing-C++/JNI] QR 解码 → [Rust/JNI]             │
│               帧解析 → RaptorQ 恢复 → 文件重组 → 保存            │
│                          │                                        │
│            libtransfer_engine.so (Rust→Android)                  │
└─────────────────────────────────────────────────────────────────┘
```

## Rust 核心库（双端共享）

```
crates/
├── raptorq-core/      RFC 6330 RaptorQ 编解码封装（纯逻辑）
│   ├── Encoder        分源块、生成源/修复符号
│   └── Decoder        接收任意顺序符号、容错恢复
├── qr-protocol/       帧格式 + 分块 + 压缩 + CRC + QR 矩阵
│   ├── frame          60B Header + 1024B Payload + 4B Footer
│   ├── compress       Zstd（native/Android）
│   ├── session        确定性会话 ID（FNV-1a 128-bit）
│   └── qr_render      qrcode crate → 模块矩阵
└── transfer-engine/   编排 + 状态机 + 进度 + 断点 + FFI
    ├── sender         帧流生成（源+修复符号交织，可配置冗余率）
    ├── receiver       帧摄入 + 去重 + 解码 + 重组
    ├── descriptor     会话描述符帧（携带 OTI，支持晚加入）
    ├── progress       恢复进度 / 吞吐量 / ETA
    ├── resume         状态序列化（断点恢复）
    ├── wasm.rs        wasm-bindgen 绑定（浏览器）
    └── jni.rs         JNI extern "C" 绑定（Android）
```

### 双端一致性保证

核心逻辑（RaptorQ、帧格式、会话 ID、CRC）全部在 Rust 中实现，通过 FFI 暴露给两端：

| 端 | 编译目标 | FFI 方式 | 产物 |
|----|---------|---------|------|
| 浏览器 | `wasm32-unknown-unknown` | `wasm-bindgen` | `transfer_engine_bg.wasm` |
| Android | `aarch64-linux-android` | `#[no_mangle] extern "C"` | `libtransfer_engine.so` |

两端调用的是**同一份 Rust 源码**，编解码结果在数学上保证一致。

## 数据流

### 发送端
```
文件字节
  │
  ├─ (可选) Zstd 压缩
  ├─ 零填充到 symbol_size 整数倍
  ├─ RaptorQ 编码（RFC 6330 自动分源块）
  ├─ 生成发射计划：源符号 + 修复符号（按冗余率交织）
  └─ 循环：每帧取一个符号 → 封装为 Frame → QR 编码 → Canvas 绘制
         （每隔 N 帧插入一个描述符帧，携带 OTI 供晚加入的接收端）
```

### 接收端
```
摄像头视频流 (YUV_420_888)
  │
  ├─ CameraX ImageAnalysis → 取 Y 平面
  ├─ ZXing-C++ 解码 → 得到 Frame 字节
  ├─ 帧校验（magic + CRC32 × 2）→ 失败则丢弃
  ├─ 解析 Header → 提取 session_id / sbn / esi
  ├─ 去重（per-block ESI 集合）
  ├─ 喂入 RaptorQ Decoder → 块满即解码
  └─ 全块解码完成 → 重组 → (可选)解压 → 保存
```

## 容错设计

| 故障 | 处理方式 |
|------|---------|
| 帧丢失 | RaptorQ 喷泉码冗余恢复（默认 10%，可配 5–50%） |
| 帧乱序 | 符号按 (sbn, esi) 索引，任意顺序均可解码 |
| 帧重复 | per-block ESI 集合去重 |
| 帧损坏 | 双层 CRC32（payload + 整帧）丢弃损坏帧 |
| 接收端重启 | 确定性 session_id + 状态持久化 → 断点恢复 |
| 晚加入 | 描述符帧定期广播 OTI，接收端随时可加入 |

## 关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| Symbol Size (T) | 1024 B | 每个 QR 帧载荷 |
| QR Version | 40 | 177×177 模块 |
| QR 纠错级别 | L | 最大化数据容量 |
| QR 容量 | 2953 B | 远超 1088 B 帧长，低密度利于扫描 |
| 默认冗余率 | 10% | 可配 5–50% |
| 帧率 | 30 / 60 fps | 可选 |
| Chunk Size | 1024 B | = symbol_size |
