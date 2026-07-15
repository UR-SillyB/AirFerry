# 系统架构 (Architecture)

## 概述

AirFerry 是一个完全离线的光学文件传输系统。发送端（浏览器扩展或网页）将文件/文字编码为二维码视频流在屏幕上连续播放；接收端（Android App / Windows 桌面）用摄像头或采集卡实时扫描并恢复内容。编解码共享同一套 Rust 核心库，分别编译为 WebAssembly、Android JNI `.so`、Windows C ABI DLL，确保数学一致。

## 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│              发送端 (Browser Extension / Web)                     │
│  Chrome/Edge/Firefox · MV2 & MV3 · Plasmo + React + TS           │
│  网页端 Vite 复用同一份 sender 源码                                │
│                                                                  │
│  统一列表（文件 + 文字）→ 显式「发送」→ [三算法选优压缩] → [Rust/WASM] │
│    Raw / Zstd Lv1 / Xz Lv9（70% early-exit）                     │
│         分块 → RaptorQ 编码 → 帧封装 → QR 矩阵 → Canvas 渲染     │
│                                      │                            │
│                          transfer_engine.wasm (Rust→WASM)        │
└──────────────────────────────────────┬──────────────────────────┘
                                       │ 屏幕二维码视频流 (默认 60 fps)
                                       │ (单向光学信道, Air-Gap)
                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│            接收端 (Android App · Windows WPF)                     │
│  Kotlin + CameraX + ZXing-C++  /  C# + OpenCvSharp + ZXing.Net   │
│                                                                  │
│  视频流 → [并行解码池] → [串行 Rust 摄入]                          │
│  帧解析 → RaptorQ 恢复 → 解压 → ETTEXTv1 / ETBUNDL1 / 文件       │
│  文本类扩展名可进复制页（TextLike）                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Rust 核心库（多端共享）

```
core/
├── raptorq-core/      RFC 6330 RaptorQ 编解码封装（纯逻辑）
│   ├── Encoder        分源块、生成源符号 + 按需生成无限修复符号
│   └── Decoder        接收任意顺序符号、容错恢复
├── qr-protocol/       帧格式 + 分块 + 压缩 + CRC + QR 矩阵
│   ├── frame          60B Header + T 字节 Payload + 4B Footer
│   ├── compress       Zstd (Lv22) + XZ 解压分发（接收侧级别）
│   ├── session        确定性会话 ID（FNV-1a 128-bit）
│   └── qr_render      fast_qr crate → 模块矩阵（按帧长选最小版本）
└── transfer-engine/   编排 + 状态机 + 进度 + 断点 + FFI
    ├── sender         帧流生成（源符号一遍 → 无限新鲜修复符号）
    ├── receiver       帧摄入 + 去重 + 解码 + 重组
    ├── descriptor     会话描述符帧（携带 OTI）
    ├── wasm.rs        wasm-bindgen（浏览器）
    ├── jni.rs         JNI（Android）
    └── cffi.rs        C ABI（Windows P/Invoke）
```

### 多端一致性保证

| 端 | 编译目标 | FFI | 产物 |
|----|---------|-----|------|
| 浏览器 / 网页 | `wasm32-unknown-unknown` | `wasm-bindgen` | `transfer_engine_bg.wasm` |
| Android | `aarch64-linux-android` | JNI | `libtransfer_engine.so` |
| Windows | `x86_64-pc-windows-msvc` | C ABI | `transfer_engine.dll` |

## 数据流

### 发送端

```
统一 pending 列表（File + 文字 content）
  │ 用户点「发送」才进入 worker
  ├─ 恰好 1 条文字、0 文件 → ETTEXTv1（processText）
  ├─ 否则文字物化为命名 .txt + 文件 → ≥2 则 ETBUNDL1
  ├─ 三算法选优压缩 (Raw / Zstd Lv1 / Xz Lv9)，70% early-exit
  ├─ 零填充到 symbol_size 整数倍
  ├─ RaptorQ 编码（RFC 6330 自动分源块）
  └─ 源符号一遍 → 无限新鲜修复符号；每 16 帧插描述符（首帧即描述符）
         Frame → QR 编码 → Canvas（单码或 4 码 tile）
```

> **无限新鲜修复符号**：源符号发完后持续产生从未见过的修复符号，进度近似线性，避免 coupon-collector 拖尾。

### 接收端

```
摄像头 / 采集卡视频流 (~60fps)
  │
  ├─ 生产者拷贝帧入队 → N worker 并行 ZXing 解码
  ├─ 串行 ingest（锁）：帧校验 → 去重 → RaptorQ
  └─ assemble + 解压后分流：
       ① ETTEXTv1 → ReceiveText（复制/分享/存盘）
       ② ETBUNDL1 → 拆包；文本类扩展名可点进 ReceiveText
       ③ 单文件 + TextLike 扩展名 + 严格 UTF-8 → ReceiveText
       ④ 否则 → 普通文件详情
```

> **并行解码池**：采集与解码解耦；原生 receiver 句柄非线程安全，ingest 必须串行。详见 [data-flow.md](data-flow.md)。

## 容错设计

| 故障 | 处理方式 |
|------|---------|
| 帧丢失 | RaptorQ 喷泉码 + 无限新鲜修复符号 |
| 帧乱序 | 符号按 (sbn, esi) 索引 |
| 帧重复 | per-block ESI 集合去重 |
| 帧损坏 | 双层 CRC32 丢弃 |
| 接收端重启 | 确定性 session_id + 状态持久化 |
| 晚加入 | 描述符帧定期广播 OTI |
| 恶意/越界描述符 | `ObjectMeta::validate` |
| 越界符号坐标 | 拒绝 ESI ≥ 2²⁴ 或载荷长度 ≠ symbol_size |
| 解压炸弹 | 按 `original_size` 封顶 |

## 关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| Symbol Size (T) | 浏览器默认 **1400** / 核心库默认 **1024** | 每帧载荷；收端从帧头自适应 |
| 速度预设 | 512 / 896 / 1008 / **1400（默认）** / 1900 / 2400 | 见 [qr-frame-format.md](qr-frame-format.md) |
| QR Version | 动态最小 | **1464B 帧 → V27 (125×125)**；1088B → V23 |
| QR 纠错 | L | 最大化容量 |
| 4 码并行 | 默认 4 | 同帧 tile 4 符号 |
| 默认冗余率 | 5% | 仅 UI 时长估算 |
| 描述符间隔 | 16 帧 | 首帧即描述符 |
| 帧率 | 20 / 30 / 45 / 60（默认）/ 120 / 0=无限制 | `types.ts` + Params UI |
| 接收采集（Android） | ~60fps | **ImageAnalysis 1920×1080** |
| 亚像素抖动 | 默认关 | ±1px 打散摩尔纹 |

## 多文件 / 混发

- ≥2 项（文件和/或文字 `.txt`）→ `ETBUNDL1` 单容器，一条压缩 + 一条 RaptorQ 流。
- 单文件不打包（向后兼容）。
- 单条纯文字 → `ETTEXTv1`（descriptor 文件名 `文字消息.txt`）。
- 格式见 [protocol.md](protocol.md)、[SPEC.md](SPEC.md)。

## 4 码并行模式

默认 `multiQr=4`。详见 [qr-frame-format.md](qr-frame-format.md#4-码并行模式)。

## 速度预设与帧率

六档 symbol 预设 + 独立 fps（含 120、无限制）。`redundancy_pct` 仅估算用。详见 [qr-frame-format.md](qr-frame-format.md)。

## 亚像素抖动

`ditherJitter` 默认关。详见 [qr-frame-format.md](qr-frame-format.md#亚像素抖动-dither)。
