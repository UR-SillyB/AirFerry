# 数据流图 (Data Flow)

## 发送端数据流

```
        ┌──────────────────┐
        │ 1 个或多个文件     │  ≥2 文件 → 打包
        └────┬─────────────┘
             │
             ▼  (≥2 文件)
       ┌──────────────┐
       │ 多文件打包     │  buildBundle → ETBUNDL1 单容器
       │ (bundle.ts)   │  整批走一条压缩 + 一条 RaptorQ 流
       └────┬─────────┘
            │ 1 文件则原样直传（向后兼容）
            ▼ 原始字节
                ┌────────────────────┐
                │ 三算法选优压缩      │  Raw / Zstd Lv1 / Xz Lv9
                │ preparePayload     │  70% Zstd early-exit 跳过慢速 XZ
                │ (compress.worker)  │  压缩标签写入描述符帧
                └────┬───────────────┘
                     │ 压缩字节
                     ▼
              ┌──────────────┐
              │ 零填充对齐    │  chunker::pad_to_symbols
              │ → N×T 字节   │  T = symbol_size（浏览器默认 1400）
              └────┬─────────┘
                   │
                   ▼
        ┌─────────────────────┐
        │ RaptorQ 编码         │  Encoder::with_defaults
        │ RFC 6330 自动分块    │  → ObjectMeta (OTI + 每块K)
        └────┬────────────────┘
             │
             ▼
   ┌──────────────────────────────┐
   │ 发射策略 (sender::next_frame) │
   │ ① 源符号阶段：跨块轮询，仅一遍 │  build_source_plan
   │ ② 无限新鲜修复符号：跨块轮询，  │  repair_symbol_id
   │    ESI 单调递增、永不重复       │  → 无重复帧
   └────┬─────────────────────────┘
        │ (sbn, esi) 序列
        ▼
    ┌──────────────────┐     每 16 帧 / 首帧
    │ 帧封装           │ ◄─── 插入描述符帧
    │ Header+Payload   │     (FLAG_DESCRIPTOR)
    │ +Footer+CRC×2    │
    └────┬─────────────┘
         │ (60+T+4) 字节帧
         ▼
   ┌──────────────┐
   │ QR 编码       │  qr_render::encode → 按帧长选最小版本
   └────┬─────────┘    （1404B 帧 → V25 117×117）
        │ 模块矩阵
        ▼
  ┌──────────────┐
  │ Canvas 渲染   │  20/30/45/60 fps（默认 60），全屏，亮度优化
  │ 单码 or 4码   │  4 码模式同帧 tile 4 个不同符号（默认开，~4× 吞吐）
  │ (±1px 抖动)   │  ditherJitter 默认关
  └──────┬───────┘
         │
         ▼
    屏幕二维码视频流 ▶ ▶ ▶ (单向光学信道)
```

> **无重复帧**：源符号发完后，每一帧都携带接收端从未见过的修复符号（ESI 永不回绕）。接收端因此不会再收到发送端造成的重复，进度近似线性。`redundancy_pct` 仅用于 UI 时长估算，不限制实际修复符号数量。

## 接收端数据流（并行解码管线）

```
              屏幕二维码视频流 ▶ ▶ ▶
                       │
                       ▼
            ┌───────────────────┐
            │ CameraX 视频流     │  ImageAnalysis @ 锁定 ~60fps
            │ YUV_420_888       │  STRATEGY_KEEP_ONLY_LATEST
            └────┬──────────────┘
                 │ 每帧（分析线程，生产者）
                 ▼
          ┌────────────────────────┐
          │ 复制 Y 平面 → 入有界队列 │  QrStreamAnalyzer → QrDecodePool.submit
          │ 立即 image.close()      │  满则丢最新（喷泉码下任意新符号等价）
          └────┬───────────────────┘
               │ ArrayBlockingQueue
               ▼
        ┌──────────────────────────────┐
        │ N 个解码 worker（并行）        │  N ≈ CPU 核数−2（钳 2–6）
        │ 中心 ROI 裁剪 → ZXing-C++     │  ROI 失败周期性回退整帧
        │ decodeY() → Frame 字节?       │
        └────┬─────────────────────────┘
             │ 解码载荷（乱序无妨）
             ▼
        ┌──────────────────────────┐
        │ 串行 JNI 摄入 (ingest 锁) │  原生 receiver 句柄非线程安全
        │ 帧校验 magic + CRC×2      │  → 一次仅一个线程
        └────┬─────────────────────┘
             │ Frame
             │
       ┌─────┴─────┐
       ▼           ▼
   描述符帧?    数据帧?
       │           │
       ▼           ▼
  ┌─────────┐  ┌──────────────┐
  │ 更新     │  │ 去重          │  per-block ESI HashSet
  │ObjectMeta│  │ (sbn,esi)   │  重复 → 丢弃
  └─────────┘  └────┬─────────┘
                    │ 唯一符号（O(1) 更新源计数器）
                    ▼
             ┌──────────────┐
             │ RaptorQ 解码 │  Decoder::add_symbol
             │ 块满即解码   │
             └────┬─────────┘
                  │ 解码块
                  ▼
           ┌──────────────┐
           │ 重组          │  assemble() → 全块拼接 → 截断真实长度
           └────┬─────────┘
                │ 恢复字节
                ▼
          ┌──────────────┐
          │ (可选) 解压   │  若发送端启用压缩
          └────┬─────────┘
               ▼
         ┌──────────────┐
         │ Bundle?      │  头部是 ETBUNDL1？
         │ BundleParser │  是 → 拆包为多个文件
         └────┬─────────┘
              ▼
         ┌──────────┐
         │ 文件保存  │  app 专属目录 / 分享（FileNameUtil 去重/分目录）
         └──────────┘
```

> **解码/摄入分离**：采集线程从不阻塞于 ZXing；解码在 N 个 worker 上并行，但所有摄入经一把 `ingest` 锁串行化（原生句柄非线程安全）。完成时接收端先置 `ingestStopped` 再在主线程 `assemble()`，确保 `&mut` 摄入与 `&` 重组不并发。会话切换/销毁通过 `runExclusive` 在锁内完成，杜绝 use-after-free。

## 实验性高速录制数据流

```
开启「高速相机录制」设置（旗舰机 + 能力检测）
        │
        ▼
 Camera2 高速会话 (120/240fps)
   └─► MediaCodec 全 I 帧 H.264 编码器 (KEY_I_FRAME_INTERVAL=0)
         └─► MediaMuxer → 临时 .mp4
        │ 用户停止录制
        ▼
 MediaExtractor + MediaCodec 解码器 → ImageReader(YUV)
   └─► 每帧 Y 平面 → 复用 QrDecodePool（与实时路径相同的串行摄入）
        │
        ▼
   与常规路径相同的 RaptorQ 恢复 / 重组 / 保存
（任一步失败 → onError → 释放控制器 → 回退常规实时管线）
```

## 进度反馈流

```
QrDecodePool worker → (ingest 锁) → ReceiverSession.ingest(frame)
        │
        ├──► RaptorQ Decoder（块解码）
        │
        ▼
   Progress {
     decoded_symbols,     // 已解码源符号数（含 O(1) 增量源计数器近似）
     total_symbols,       // K
     received_symbols,    // 去重后接收数
     decoded_blocks,      // 已完成块数
     total_blocks,
     frames_seen/duplicate/corrupt,
     decoded_fraction,    // 0.0–1.0（近似线性增长）
     loss_ratio,          // 丢帧率
   }
        │
        ▼ (JSON via JNI，节流 ~7Hz)
   Kotlin UI → 进度条 + 解码速率/秒 + 统计
```
