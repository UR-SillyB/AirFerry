# 数据流图 (Data Flow)

## 发送端数据流

```
        ┌────────────────────────────┐
        │ 统一 pending 列表           │  添加文件（拖拽/点选/文件夹，追加）
        │ PendingItem[]              │  添加文字（弹窗 → 命名 .txt + content）
        └────┬───────────────────────┘
             │ 用户点「发送」（此前不压缩、不跳页）
             ▼
     ┌───────┴────────┐
     │ 1×text 且无文件 │ 否则（文件和/或 ≥1 文字）
     ▼                ▼
 processText      文字→File(.txt) + 文件
 ETTEXTv1         ≥2 → buildBundle(ETBUNDL1)
     │                │ 1 项 → 单文件路径
     └───────┬────────┘
             ▼
                ┌────────────────────┐
                │ 三算法选优压缩      │  Raw / Zstd Lv1 / Xz Lv9
                │ preparePayload     │  70% Zstd early-exit
                │ (compress.worker)  │
                └────┬───────────────┘
                     ▼
              ┌──────────────┐
              │ 零填充对齐    │  T = symbol_size（浏览器默认 1400）
              │ → N×T 字节   │
              └────┬─────────┘
                   ▼
        ┌─────────────────────┐
        │ RaptorQ 编码         │  Encoder::with_defaults
        └────┬────────────────┘
             ▼
   ┌──────────────────────────────┐
   │ 发射策略 (sender::next_frame) │
   │ ① 源符号跨块轮询一遍          │
   │ ② 无限新鲜修复符号（ESI↑）    │
   └────┬─────────────────────────┘
        ▼
    ┌──────────────────┐     每 16 帧 / 首帧
    │ 帧封装           │ ◄─── 描述符帧
    │ Header+Payload   │
    │ +Footer+CRC×2    │
    └────┬─────────────┘
         │ (60+T+4) 字节帧
         ▼
   ┌──────────────┐
   │ QR 编码       │  min_version_for（1464B → V27 125×125）
   └────┬─────────┘
        ▼
  ┌──────────────┐
  │ Canvas 渲染   │  next_qr_*_into + drawMatrix + putImageData
  │ 单码 or 4码   │  默认 multiQr=4；fps 默认 60
  └──────┬───────┘
         ▼
    屏幕二维码视频流 ▶ ▶ ▶
```

> **无重复帧**：源发完后每帧都是新修复符号。`redundancy_pct` 仅 UI 估算。

## 接收端数据流（并行解码管线）

```
              屏幕二维码视频流 ▶ ▶ ▶
                       │
                       ▼
            ┌───────────────────┐
            │ 摄像头 / 采集卡    │  Android: ImageAnalysis @ ~60fps, 1920×1080
            │                   │  Windows: OpenCvSharp DirectShow
            └────┬──────────────┘
                 ▼
          ┌────────────────────────┐
          │ 拷贝帧 → 有界队列       │  满则丢最新（喷泉码）
          └────┬───────────────────┘
               ▼
        ┌──────────────────────────────┐
        │ N 个解码 worker（并行）        │  ZXing 单码/多码/ROI
        └────┬─────────────────────────┘
             ▼
        ┌──────────────────────────┐
        │ 串行 ingest（锁）         │  原生句柄非线程安全
        │ magic + CRC×2            │
        └────┬─────────────────────┘
             ▼
       描述符 / 数据符号 → RaptorQ → assemble + 解压
             ▼
         ┌──────────────────────────────────────┐
         │ ① ETTEXTv1? → ReceiveText            │
         │ ② ETBUNDL1? → 拆包；.txt 等可点复制   │
         │ ③ TextLike 文件名 + 严格 UTF-8?       │
         │      → ReceiveText                   │
         │ ④ 否则 → 单文件详情 / 分享 / 存盘     │
         └──────────────────────────────────────┘
```

> **解码/摄入分离**：完成时先 `ingestStopped` 再 `assemble()`。会话切换在锁内完成。

## 进度反馈流

```
解码 worker → (ingest 锁) → ReceiverSession.ingest(frame)
        │
        ▼
   Progress { decoded_symbols, total_symbols, received_symbols,
              decoded_fraction, loss_ratio, ... }
        │
        ▼ (JSON / 位域，UI 节流 ~7Hz)
   进度条 + 解码速率/秒 + 统计
```
