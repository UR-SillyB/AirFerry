# 系统架构 (Architecture)

## 概述

AirFerry 是一个完全离线的光学文件传输系统。发送端（浏览器扩展或网页）将文件/文字编码为二维码视频流在屏幕上连续播放；接收端（网页 / Android App / Windows 桌面）用摄像头、采集卡或（Windows 端）屏幕区域/窗口捕获实时扫描并恢复内容。编解码共享同一套 Rust 核心库，分别编译为 WebAssembly、Android JNI `.so`、Windows C ABI DLL，确保数学一致。

## 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│              发送端 (Browser Extension / Web)                     │
│  Chrome/Edge/Firefox · MV2 & MV3 · Vite + React + TS             │
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
│  帧解析 → RaptorQ 恢复 → Manifest → 按条目 kind 路由              │
│  （UTF8_TEXT → 文本页；FILE/DIRECTORY → 文件/目录结构）             │
└─────────────────────────────────────────────────────────────────┘
```

## 共享核心（Rust 协议引擎 + C++ 相机解码）

```
core/
├── af2/                 AF2 协议层（帧格式、三层 ID、BLAKE3、Manifest、OTI、状态机、Playlist）
│   ├── frame            26B Header + T 字节 Payload + 4B 单帧 CRC（ROOT/META/SYMBOL）
│   ├── id               三层身份派生（Content / Transfer / Object ID，BLAKE3-256）
│   ├── root / meta      会话 ROOT 与 OBJECT_META 记录（含 OTI、raw/encoded hash）
│   ├── manifest         80B 头 + Entry Records(kind) + Chunk Hash Table + TLV
│   ├── sender/receiver  收发状态机（源符号一遍 → 持续新鲜修复符号；
│   │                    Idle→Locked→Decode→Ready）
│   └── tlv              四作用域 TLV 编解码（Critical 位 fail-closed）
├── raptorq-core/         RFC 6330 RaptorQ 编解码封装（纯逻辑）
│   ├── Encoder          分源块、生成源符号 + 按需生成新鲜修复符号
│   └── Decoder          接收任意顺序符号、容错恢复
├── qr-protocol/          压缩 + CRC + QR 矩阵
│   ├── compress         Zstd + XZ 有界编解码（严格变小才压缩）
│   └── qr_render        fast_qr crate → 模块矩阵（按帧长选最小版本）
├── transfer-engine/      编排 + 状态机 + 进度 + 快照 + FFI（re-export `af2`）
│   ├── wasm.rs          wasm-bindgen（浏览器）
│   ├── jni.rs           JNI（Android）
│   └── cffi.rs          C ABI（Windows P/Invoke）
└── zxing-decoder/       Windows 对 Android v1.1.3 模式的 ZXing-C++ 实现
    ├── DecodeMultiFull / DecodeMultiRegions
    └── packed payload + bbox 结果布局
```

### 多端一致性保证

| 端 | 编译目标 | FFI | 产物 |
|----|---------|-----|------|
| 浏览器 / 网页 | `wasm32-unknown-unknown` | `wasm-bindgen` | `transfer_engine_bg.wasm` |
| Android | `aarch64-linux-android` | JNI | `libtransfer_engine.so` |
| Windows | `x86_64-pc-windows-msvc` | C ABI | `transfer_engine.dll` |

相机识别使用同一模式、不同平台桥接：Android 的 `QrDecodePool.kt` / `scan_jni.cpp` 锁定为 v1.1.3 解码路径，产出 `libairferry_zxing.so`；Windows 的 `QrDecodePool.cs` 镜像相同 worker、队列、4 符号批摄入及全帧/ROI 状态机，`native/zxing_capi.cpp` 调用 `core/zxing-decoder/` 产出 `airferry_zxing.dll`。两端也共享 Rust 帧协议与 RaptorQ 引擎。

## 数据流

### 发送端

```
        ┌────────────────────────────┐
        │ 统一 pending 列表           │  添加文件（全页拖放/点选/文件夹，追加）
        │ PendingItem[]              │  添加文字（弹窗 → 命名 .txt + content）
        └────┬───────────────────────┘
             │ 用户点「发送」（此前不压缩、不跳页）
             ▼
     ┌───────┴────────┐
     │ 1×text 且无文件 │ 否则（文件和/或 ≥1 文字）
     ▼                ▼
 单一 UTF8_TEXT     文字→File(.txt) + 文件
 条目               ≥2 → 多条目 Manifest（AFM2）
     │                │ 1 项 → 单文件条目
     └───────┬────────┘
             ▼
   ┌────────────────────────────┐
   │ 构建 AF2 Sender（AF2Sender）│  add_entry(kind, path, content)
   │  Manifest + 定长切块        │  chunk_raw_size 默认 8 MiB（1..32 MiB）
   └────┬───────────────────────┘
        │ 逐 chunk 三算法选优压缩   Raw / Zstd Lv1 / Xz Lv9
        │ （严格变小才压缩）        （compress.worker 读取 + 计算哈希）
        ▼
      ┌──────────────┐
      │ RaptorQ 编码  │  OTI-only 分区推导（RFC 6330）
      └────┬─────────┘
           ▼
   ┌──────────────────────────────┐
   │ 发射策略 (af2::sender)        │
   │ ① Bootstrap: ROOT+META+Manifest│
   │ ② 源符号跨块轮询一遍          │
   │ ③ 持续新鲜修复符号（ESI↑）    │
   └────┬─────────────────────────┘
        ▼
    ┌──────────────────┐     META 每 ~17 帧、ROOT 每 ~31 帧插入
    │ 帧封装           │     （AF2 帧：26B Header + T Payload + 4B CRC）
    └────┬─────────────┘     (26+T+4) 字节帧
         ▼
   ┌──────────────┐
   │ QR 编码       │  min_version_for（1430B → V27 125×125）
   └────┬─────────┘
        ▼
  ┌──────────────┐
  │ Canvas 渲染   │  next_qr_scratch/view + drawMatrix + putImageData
  │ 单码 or 4码   │  默认 multiQr=4；fps 默认 60
  └──────┬───────┘
         ▼
    屏幕二维码视频流 ▶ ▶ ▶
```

> **持续新鲜修复符号**：源符号发完后持续产生从未见过的修复符号，进度近似线性；每块 ESI 达 2²⁴ 时明确停止，避免回绕或 panic。`redundancy_pct` 仅 UI 估算。

### 接收端

```
              屏幕二维码视频流 ▶ ▶ ▶
                       │
                       ▼
            ┌───────────────────┐
            │ 摄像头 / 采集卡    │  Android: ImageAnalysis @ ~60fps, 1920×1080
            │                   │  Windows: OpenCvSharp DirectShow
            └────┬──────────────┘
                 ├── Windows: 同一次读取按 15fps 池化快照 → WPF 预览
                 ▼
          ┌────────────────────────┐
          │ 池化 Gray 一次拷贝→队列 │  满则丢最新（喷泉码）
          └────┬───────────────────┘
               ▼
        ┌──────────────────────────────┐
        │ 2–6 解码 worker（并行）        │  Android v1.1.3 JNI / Windows 等价 C#/C ABI 模式
        └────┬─────────────────────────┘
             ▼
        ┌──────────────────────────┐
        │ 串行 ingest（锁）         │  原生句柄非线程安全
        │ magic + 帧 CRC           │
        └────┬─────────────────────┘
             ▼
      ROOT/META 绑定 → RaptorQ 恢复 → Manifest 恢复 → 逐 chunk 解压
      （每 chunk 按 encoded_hash/raw_hash 校验；磁盘/IndexedDB 账本，
        原生端流式解压写盘，bounded RAM）
             ▼
         ┌──────────────────────────────────────┐
         │ 按 Manifest Entry.kind 路由：          │
         │ ① UTF8_TEXT?      → ReceiveText       │
         │ ② FILE + TextLike + 严格 UTF-8?      │
         │      → ReceiveText（可复制）          │
         │ ③ 多条目           → 拆包列表/目录     │
         │ ④ 否则单文件      → 文件详情/分享/存盘 │
         └──────────────────────────────────────┘
```

> **并行解码池 / 解码摄入分离**：采集与解码解耦；QR 识别可并行，但原生 receiver 句柄非线程安全，ingest 必须串行。完成时先停止摄入再 `assemble()`；会话切换和进度快照都在 ingest 锁内完成。Android 的 worker/批摄入/全帧与 ROI 状态机及 JNI 识别逻辑固定为 v1.1.3；Windows 用 C#/C ABI 镜像相同 worker 数、队列容量、4 符号批摄入、miss 状态机和 TryHarder/TryInvert 选项。进度 UI 从一致快照展示接收进度、3 秒窗口速率和有效吞吐；不再展示容易误判的逐二维码活跃/暂停状态。

### 进度反馈流

```
解码 worker → (ingest 锁) → ReceiverSession.ingest(frame)
        │
        ▼
   Progress { decoded_symbols, total_symbols, received_symbols,
              decoded_fraction, loss_ratio, ... }
        │
        ▼ (JSON / 位域，UI 节流 ~7Hz)
   进度条 + 3 秒窗口解码速率 + 有效吞吐 + 文件大小
```

## 容错设计

| 故障 | 处理方式 |
|------|---------|
| 帧丢失 | RaptorQ 喷泉码 + 持续新鲜修复符号 |
| 帧乱序 | 符号按 (sbn, esi) 索引 |
| 帧重复 | per-block ESI 集合去重 |
| 帧损坏 | 帧级 CRC32-IEEE 丢弃（覆盖 Header + Payload） |
| 大文件接收端重启 | 已验证完成 chunk 持久化；未完成的 chunk 由后续新鲜修复符号重扫 |
| 不同文件修订版混入 | Object ID 解码前绑定（含 encoded_hash）杜绝混流 |
| 存储空间不足 | 逐 chunk 写盘前预检，并保留 64 MiB 安全余量 |
| 成品归档中途崩溃 | 同卷原子移动 + 预期内容摘要恢复；重试不生成重复记录 |
| 晚加入 | ROOT 每 ~31 帧、OBJECT_META 每 ~17 帧定期广播 OTI |
| 恶意/越界 META/Manifest | `ObjectMeta::validate` + Manifest 路径/长度校验 |
| 越界符号坐标 | 拒绝 ESI ≥ 2²⁴ 或载荷长度 ≠ symbol_size |
| 解压炸弹 | 原生端流式解压按 `original_size` 封顶；网页端按浏览器接收上限封顶 |

## 关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| Symbol Size (T) | 浏览器默认 **1400** / 核心库默认 **1024** | 每帧载荷；收端从帧头自适应 |
| 速度预设 | 512 / 896 / 1008 / **1400（默认）** / 1904 / 2400 | 均为 8 字节倍数；见 [SPEC.md](SPEC.md) |
| QR Version | 动态最小 | **1430B 帧 → V27 (125×125)**；1088B → V23 |
| QR 纠错 | L | 最大化容量 |
| 4 码并行 | 默认 4 | 同帧 tile 4 符号 |
| 默认冗余率 | 5% | 仅 UI 时长估算 |
| META/ROOT 间隔 | ~17/31 帧 | 周期轮转 OBJECT_META 与 ROOT |
| 帧率 | 15 / 20 / 30 / 45 / 60（默认）/ 90 / 120 / 0=无限制 | `types.ts` + Params UI |
| 接收采集（Android） | ~60fps | **ImageAnalysis 1920×1080** |
| 亚像素抖动 | 默认关 | ±1px 打散摩尔纹 |

## 性能基准（实测）

- **Rust 核心不是瓶颈**：WASM 接收端 ingest 约 1000 MiB/s（~100 万符号/秒）；8 MB 文件完整恢复约 7.3 ms。
- **光学信道才是瓶颈**：默认 1400B 符号、60 fps 下理论上限约 78 KiB/s（单码）/ 308 KiB/s（四码）；核心算力富余约 4000 倍。接收端实际瓶颈在摄像头采集帧率与 ZXing 解码，不在 Rust 核心。

## 多文件与混发

- 1–4096 项（文件、文字、目录）统一由 AF2 Manifest 描述与分块，结构化传输。
- 格式与位级契约详见 [SPEC.md](SPEC.md)。

## 4 码并行模式

默认 `multiQr=4`，同屏渲染 4 个并行 QR 码，提升光学吞吐量。

## 速度预设与帧率

六档 symbol 预设（T = 512..2400）+ 独立 fps。详见 [SPEC.md](SPEC.md)。

## 亚像素抖动

`ditherJitter` 默认关（±1px 打散摩尔纹）。
