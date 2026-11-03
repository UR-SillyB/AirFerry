# 系统架构 (Architecture)

## 概述

AirFerry 是一个完全离线的光学文件传输系统。浏览器扩展和网页将文件/文字编码为二维码视频流在屏幕上连续播放，Python 发送端将单个文件导出为有限长度 MP4；接收端（网页 / Android App / Windows 桌面）用摄像头、采集卡或（Windows 端）屏幕区域/窗口捕获实时扫描并恢复内容。编解码共享同一套 Rust 核心库，分别编译为 WebAssembly、Android JNI `.so`、Windows C ABI DLL 和 Python PyO3 扩展，确保协议一致。

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
│       接收端 (Web · Android App · Windows WPF)                    │
│ Web Worker / Kotlin+CameraX / C#+OpenCvSharp + ZXing 解码         │
│                                                                  │
│  视频流 → [并行解码池] → [串行 Rust 摄入]                          │
│  帧解析 → RaptorQ 恢复 → 解压 → ETTEXTv1 / ETBUNDL1 / 文件       │
│  文本类扩展名可进复制页（TextLike）                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 共享核心（Rust 协议引擎 + C++ 相机解码）

```
core/
├── raptorq-core/      RFC 6330 RaptorQ 编解码封装（纯逻辑）
│   ├── Encoder        分源块、生成源符号 + 按需生成新鲜修复符号
│   └── Decoder        接收任意顺序符号、容错恢复
├── qr-protocol/       帧格式 + 分块 + 压缩 + CRC + QR 矩阵
│   ├── frame          60B Header + T 字节 Payload + 4B Footer
│   ├── compress       Zstd + XZ 解压分发与输出上限
│   ├── session        确定性会话 ID（FNV-1a 128-bit）
│   └── qr_render      fast_qr crate → 模块矩阵（按帧长选最小版本）
├── transfer-engine/   编排 + 状态机 + 进度 + 断点 + FFI
│   ├── sender         帧流生成（源符号一遍 → 持续新鲜修复符号）
│   ├── receiver       帧摄入 + 去重 + 解码 + 重组
│   ├── descriptor     会话描述符帧（携带 OTI）
│   ├── wasm.rs        wasm-bindgen（浏览器）
│   ├── jni.rs         JNI（Android）
│   └── cffi.rs        C ABI（Windows P/Invoke）
└── zxing-decoder/     Windows 对 Android v1.1.3 模式的 ZXing-C++ 实现
    ├── DecodeMultiFull / DecodeMultiRegions
    └── packed payload + bbox 结果布局
```

### 多端一致性保证

| 端 | 编译目标 | FFI | 产物 |
|----|---------|-----|------|
| 浏览器 / 网页 | `wasm32-unknown-unknown` | `wasm-bindgen` | `transfer_engine_bg.wasm` |
| Android | `aarch64-linux-android` | JNI | `libtransfer_engine.so` |
| Windows | `x86_64-pc-windows-msvc` | C ABI | `transfer_engine.dll` |
| Python 发送端 | 主机 Windows / Linux / macOS | PyO3 `abi3-py310` | `airferry._native` 平台 wheel |

Python 绑定位于 `apps/python/src/lib.rs`，直接调用共享发送器与 QR 渲染器；Python 层使用 Pillow 整倍数放大二维码，通过管道交给安装时附带的 FFmpeg 写入 MP4。压缩与编码计算不调用在线服务，也不在运行时补下载组件；文件、输出和临时存储按正常文件 I/O 访问，可位于 UNC、映射盘或 NFS 等文件系统，支持 `file://` URL。网络存储读写可能产生网络流量。FFmpeg 的 `file,pipe` 协议通过系统文件 API 支持这些存储。压缩流先写临时文件，再按规范逐段编码；有限视频的冗余预算、每段最低一秒与离线计算约束见 [Python 构建与使用](build-python.md)。

相机识别使用同一模式、不同平台桥接：Android 的 `QrDecodePool.kt` / `scan_jni.cpp` 锁定为 v1.1.3 解码路径，产出 `libairferry_zxing.so`；Windows 的 `QrDecodePool.cs` 镜像相同 worker、队列、4 符号批摄入及全帧/ROI 状态机，`native/zxing_capi.cpp` 调用 `core/zxing-decoder/` 产出 `airferry_zxing.dll`。两端也共享 Rust 帧协议与 RaptorQ 引擎。

## 数据流

### 发送端

```
统一 pending 列表（File + 文字 content）
  │ 用户点「发送」才进入 worker
  ├─ 恰好 1 条文字、0 文件 → ETTEXTv1（processText）
  ├─ 否则文字物化为命名 .txt + 文件 → ≥2 则 ETBUNDL1
  ├─ 三算法选优压缩 (Raw / Zstd Lv1 / Xz Lv9)，70% early-exit
  ├─ 整段压缩一次；压缩流 > ~32 MiB → 按 ~32 MiB 切压缩流段（文件/包/文字均可）
  ├─ 零填充到 symbol_size 整数倍
  ├─ RaptorQ 编码（RFC 6330 自动分源块）
  └─ 源符号一遍 → 持续新鲜修复符号；每 17 帧插描述符（首帧即描述符，多码布局下轮转码位）
         Frame → QR 编码 → Canvas（单码或 4 码 tile）
```

> **持续新鲜修复符号**：源符号发完后持续产生从未见过的修复符号，进度近似线性；每块 ESI 达 2²⁴ 时明确停止，避免回绕或 panic。

### 接收端

```
摄像头 / 采集卡 / [Windows] 屏幕区域·窗口捕获 (~60fps)
  │
  ├─ 生产者将 Gray 池化拷贝一次入队 → 2–6 worker 并行 ZXing-C++
  ├─ Android：v1.1.3 调度/JNI；Windows：等价 C#/C ABI 模式
  ├─ Windows 同一采集句柄节流 BGR24 快照 → WPF 预览（UI 不读设备）
  ├─ 串行 ingest（锁）：帧校验 → 去重 → RaptorQ
  └─ assemble + 解压后分流：
       ⓪ descriptor-v5 → 逐段 SHA 校验 + 磁盘/IndexedDB 账本；原生端流式解压写盘（bounded RAM）
       ① ETTEXTv1 → ReceiveText（复制/分享/存盘）
       ② ETBUNDL1 → 拆包；文本类扩展名可点进 ReceiveText
       ③ 单文件 + TextLike 扩展名 + 严格 UTF-8 → ReceiveText
       ④ 否则 → 普通文件详情
```

> **并行解码池**：采集与解码解耦；QR 识别可并行，但原生 receiver 句柄非线程安全，ingest 必须串行。进度 UI 从一致快照展示接收进度、3 秒窗口速率和有效吞吐；不再展示容易误判的逐二维码活跃/暂停状态。详见 [data-flow.md](data-flow.md)。

## 容错设计

| 故障 | 处理方式 |
|------|---------|
| 帧丢失 | RaptorQ 喷泉码 + 持续新鲜修复符号 |
| 帧乱序 | 符号按 (sbn, esi) 索引 |
| 帧重复 | per-block ESI 集合去重 |
| 帧损坏 | 双层 CRC32 丢弃 |
| 大文件接收端重启 | 已验证完成压缩段持久化；当前未完成的 ~32 MiB 段重扫 |
| 不同文件修订版分段混入 | 每段冻结 `root_sha256`；最终发布前流式重算完整根摘要 |
| 存储空间不足 | 新建根任务和逐段写入前预检，并保留 64 MiB 安全余量 |
| 成品归档中途崩溃 | 同卷原子移动 + 预期根摘要恢复；根任务派生稳定历史 ID，重试不生成重复记录 |
| 晚加入 | 描述符帧定期广播 OTI |
| 恶意/越界描述符 | `ObjectMeta::validate` |
| 越界符号坐标 | 拒绝 ESI ≥ 2²⁴ 或载荷长度 ≠ symbol_size |
| 解压炸弹 | 原生端流式解压按 `original_size` 封顶；网页端按浏览器接收上限封顶 |

## 关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| Symbol Size (T) | 浏览器默认 **1400** / 核心库默认 **1024** | 每帧载荷；收端从帧头自适应 |
| 速度预设 | 512 / 896 / 1008 / **1400（默认）** / 1904 / 2400 | 均为 8 字节倍数；见 [qr-frame-format.md](qr-frame-format.md) |
| QR Version | 动态最小 | **1464B 帧 → V27 (125×125)**；1088B → V23 |
| QR 纠错 | L | 最大化容量 |
| 4 码并行 | 默认 4 | 同帧 tile 4 符号 |
| 默认冗余率 | 5% | 仅 UI 时长估算 |
| 描述符间隔 | 17 帧 | 首帧即描述符；与 2/4 多码布局互质，轮转全部物理码位 |
| 帧率 | 15 / 20 / 30 / 45 / 60（默认）/ 90 / 120 / 0=无限制 | `types.ts` + Params UI |
| 接收采集（Android） | ~60fps | **ImageAnalysis 1920×1080** |
| 亚像素抖动 | 默认关 | ±1px 打散摩尔纹 |

## 多文件 / 混发

- 2–4096 项（文件和/或文字 `.txt`）→ `ETBUNDL1` 单容器，一条压缩 + 一条 RaptorQ 流；原生内容库批量提交历史索引，避免逐文件 O(n²) 重写。
- 单文件不打包（向后兼容）。
- 单条纯文字 → `ETTEXTv1`（descriptor 文件名 = 选择页用户命名，默认 `文字消息.txt`）。
- 格式见 [protocol.md](protocol.md)、[SPEC.md](SPEC.md)。

## 4 码并行模式

默认 `multiQr=4`。详见 [qr-frame-format.md](qr-frame-format.md#4-码并行模式)。

## 速度预设与帧率

六档 symbol 预设 + 独立 fps（含 120、无限制）。`redundancy_pct` 仅估算用。详见 [qr-frame-format.md](qr-frame-format.md)。

## 亚像素抖动

`ditherJitter` 默认关。详见 [qr-frame-format.md](qr-frame-format.md#亚像素抖动-dither)。
