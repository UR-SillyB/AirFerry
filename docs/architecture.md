# 系统架构 (Architecture)

## 概述

EasyTransfer 是一个完全离线的光学文件传输系统。发送端（浏览器扩展）将文件编码为二维码视频流在屏幕上连续播放；接收端（Android App）用摄像头实时扫描并恢复文件。两端共享同一套 Rust 核心库，分别编译为 WebAssembly 与 Android Native Library，确保编解码逻辑完全一致。

## 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        发送端 (Browser Extension)                 │
│  Chrome/Edge/Firefox · MV2 & MV3 · Plasmo + React + TS           │
│                                                                  │
│  文件 → [三算法选优压缩] → [Rust/WASM]                           │
│    Raw / Zstd Lv22 / Xz Lv9（95% early-exit）                    │
│         分块 → RaptorQ 编码 → 帧封装 → QR 矩阵 → Canvas 渲染     │
│                                      │                            │
│                          transfer_engine.wasm (Rust→WASM)        │
└──────────────────────────────────────┬──────────────────────────┘
                                       │ 屏幕二维码视频流 (30/45/60 fps)
                                       │ (单向光学信道, Air-Gap)
                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                       接收端 (Android App)                        │
│  Kotlin + CameraX + ZXing-C++                                     │
│                                                                  │
│  摄像头视频流 → [并行解码池] N×ZXing-C++/JNI → [串行 Rust/JNI]   │
│               帧解析 → RaptorQ 恢复 → 按标签解压 → 文件重组 → 保存 │
│                          │                                        │
│            libtransfer_engine.so (Rust→Android)                  │
└─────────────────────────────────────────────────────────────────┘
```

## Rust 核心库（双端共享）

```
crates/
├── raptorq-core/      RFC 6330 RaptorQ 编解码封装（纯逻辑）
│   ├── Encoder        分源块、生成源符号 + 按需生成无限修复符号
│   └── Decoder        接收任意顺序符号、容错恢复
├── qr-protocol/       帧格式 + 分块 + 压缩 + CRC + QR 矩阵
│   ├── frame          60B Header + T 字节 Payload + 4B Footer
│   ├── compress       Zstd (Lv22) + XZ 解压分发
│   ├── session        确定性会话 ID（FNV-1a 128-bit）
│   └── qr_render      qrcode crate → 模块矩阵（按帧长选最小版本）
└── transfer-engine/   编排 + 状态机 + 进度 + 断点 + FFI
    ├── sender         帧流生成（源符号一遍 → 无限新鲜修复符号）
    ├── receiver       帧摄入 + 去重 + 解码 + 重组（O(1) 进度计数）
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
  ├─ 三算法选优压缩 (Raw / Zstd Lv22 / Xz Lv9)
  │   95% Zstd early-exit：若 Zstd 压缩率 ≥ 95% 则跳过 XZ
  │   选取所有已运行候选中最小结果
  ├─ 零填充到 symbol_size 整数倍
  ├─ RaptorQ 编码（RFC 6330 自动分源块）
  ├─ 源符号发射计划（跨块轮询，仅一遍）
  └─ 循环：源符号发完后无限生成**新鲜**修复符号（ESI 单调递增，永不重复）
         每帧封装为 Frame → QR 编码 → Canvas 绘制
         （每 16 帧插入一个描述符帧，携带 OTI + 压缩标签 + 文件元数据；
          首帧即描述符，便于即时加入）
```

> **无限新鲜修复符号**：发送端不再循环一个有限的发射计划，而是在源符号发完后持续产生接收端从未见过的修复符号。这样接收端不会再收到发送端造成的重复帧，进度近似线性增长到 100%，避免了"越往后越慢"的 coupon-collector 拖尾。

### 接收端
```
摄像头视频流 (YUV_420_888, 锁定 ~60fps)
  │
  ├─ CameraX ImageAnalysis（生产者）→ 复制 Y 平面入有界队列后立即 close()
  ├─ N 个解码 worker 并行：中心 ROI 裁剪 → ZXing-C++ 解码 → Frame 字节
  ├─ 串行 JNI 摄入（ingest 锁）：帧校验（magic + CRC32×2）→ 失败丢弃
  ├─ 解析 Header → 提取 session_id / sbn / esi
  ├─ 去重（per-block ESI 集合）
  ├─ 喂入 RaptorQ Decoder → 块满即解码
  └─ 全块解码完成 → 重组 → 按压缩标签解压（None/Zstd/XZ）→ 保存
```

> **并行解码池**：采集与解码解耦。CameraX 分析线程只做轻量的 Y 平面拷贝并入队，N 个 worker（≈ CPU 核数−2，钳制 2–6）并行跑 ZXing；由于原生 receiver 句柄**非线程安全**，所有解码结果通过一把 ingest 锁串行喂入。解码顺序无关紧要（符号按 (sbn,esi) 索引）。详见 [data-flow.md](data-flow.md)。

## 容错设计

| 故障 | 处理方式 |
|------|---------|
| 帧丢失 | RaptorQ 喷泉码冗余恢复（源符号发完后无限补充新鲜修复符号） |
| 帧乱序 | 符号按 (sbn, esi) 索引，任意顺序均可解码；并行 worker 乱序摄入无影响 |
| 帧重复 | per-block ESI 集合去重；发送端不再产生重复帧 |
| 帧损坏 | 双层 CRC32（payload + 整帧）丢弃损坏帧 |
| 接收端重启 | 确定性 session_id + 状态持久化 → 断点恢复 |
| 晚加入 | 描述符帧定期广播 OTI；仅靠修复符号也能完整恢复 |

## 关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| Symbol Size (T) | 浏览器默认 512 B / 核心库默认 1024 B | 每个 QR 帧载荷；接收端从帧头读取并自适应 |
| QR Version | 动态最小版本 | 512B 帧 → V16 (81×81)；1024B 帧 → V23 (109×109) |
| QR 纠错级别 | L | 最大化数据容量 |
| 默认冗余率 | 25% | 仅用于发送时长估算；实际发射无限新鲜修复符号，不受其限制 |
| 描述符间隔 | 16 帧 | 首帧即描述符；约 6% 信道用于元数据 |
| 帧率 | 30 / 45 / 60 fps（默认 45） | 可选 |
| 接收采集 | 锁定 60fps（回退 30–60） | 1280×720 ImageAnalysis |
| Chunk Size | = symbol_size | 分块大小 |

## 实验性功能

**高速相机录制模式**（设置中开启，旗舰机限定）：用 Camera2 的 `CameraConstrainedHighSpeedCaptureSession`（120/240fps）→ 全 I 帧 H.264 编码录制 → 事后用解码器批量回放每帧给同一解码池。受限于 Android 高速会话只能输出到编码器（无法直接给 CPU 逐帧），且有损压缩会降低密集 QR 的识别率，因此默认关闭、能力检测门控、失败自动回退常规实时管线。详见 [data-flow.md](data-flow.md)。
