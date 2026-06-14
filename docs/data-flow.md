# 数据流图 (Data Flow)

## 发送端数据流

```
                    ┌─────────┐
                    │  文件    │
                    └────┬────┘
                         │ 原始字节
                         ▼
                ┌────────────────┐
                │ Zstd 压缩      │  (浏览器: JS / Android: Rust zstd)
                │ preparePayload │  v1 默认透传, 可启用压缩
                └────┬───────────┘
                     │ 压缩字节
                     ▼
              ┌──────────────┐
              │ 零填充对齐    │  chunker::pad_to_symbols
              │ → N×1024B    │
              └────┬─────────┘
                   │
                   ▼
        ┌─────────────────────┐
        │ RaptorQ 编码         │  Encoder::with_defaults
        │ RFC 6330 自动分块    │  → ObjectMeta (OTI + 每块K)
        └────┬────────────────┘
             │ 源符号 + 修复符号
             ▼
      ┌───────────────┐
      │ 发射计划生成   │  build_emission_plan
      │ 源符号 × K    │  + 修复符号 × K×冗余率
      └────┬──────────┘
           │ (sbn, esi) 序列
           ▼
    ┌──────────────────┐     每 N 帧
    │ 帧封装           │ ◄─── 插入描述符帧
    │ Header+Payload   │     (FLAG_DESCRIPTOR)
    │ +Footer+CRC×2    │
    └────┬─────────────┘
         │ 1088B 帧字节
         ▼
   ┌──────────────┐
   │ QR 编码       │  qrcode crate → QrMatrix (177×177)
   └────┬─────────┘
        │ 模块矩阵
        ▼
  ┌──────────────┐
  │ Canvas 渲染   │  30/60 fps, 全屏, 亮度优化
  └──────┬───────┘
         │
         ▼
    屏幕二维码视频流 ▶ ▶ ▶ (单向光学信道)
```

## 接收端数据流

```
              屏幕二维码视频流 ▶ ▶ ▶
                       │
                       ▼
            ┌───────────────────┐
            │ CameraX 视频流     │  ImageAnalysis
            │ YUV_420_888       │  STRATEGY_KEEP_ONLY_LATEST
            └────┬──────────────┘
                 │ 每帧
                 ▼
          ┌──────────────┐
          │ Y 平面提取    │  planes[0].buffer
          └────┬─────────┘
               │ ByteArray
               ▼
        ┌───────────────┐
        │ ZXing-C++     │  decodeY() → ByteArray?
        │ QR 解码       │  (实时, 非截图)
        └────┬──────────┘
             │ 帧字节 (或 null)
             ▼
      ┌──────────────┐
      │ 帧解析 + 校验 │  Frame::from_bytes
      │ magic + CRC  │  失败 → 丢弃
      └────┬─────────┘
           │ Frame
           │
     ┌─────┴─────┐
     ▼           ▼
 描述符帧?    数据帧?
     │           │
     ▼           ▼
┌─────────┐  ┌──────────────┐
│ 更新     │  │ 去重          │  per-block ESI HashSet
│ ObjectMeta│ │ (sbn,esi)   │  重复 → 丢弃
└─────────┘  └────┬─────────┘
                  │ 唯一符号
                  ▼
           ┌──────────────┐
           │ RaptorQ 解码 │  Decoder::add_symbol
           │ 块满即解码   │
           └────┬─────────┘
                │ 解码块
                ▼
         ┌──────────────┐
         │ 重组          │  assemble() → 全块拼接
         │ → 截断真实长度│
         └────┬─────────┘
              │ 恢复字节
              ▼
        ┌──────────────┐
        │ (可选) 解压   │  若发送端启用压缩
        └────┬─────────┘
             │
             ▼
       ┌──────────┐
       │ 文件保存  │  SAF / app 专属目录
       └──────────┘
```

## 进度反馈流

```
ReceiverSession.ingest(frame)
        │
        ├──► RaptorQ Decoder (块解码)
        │
        ▼
   Progress {
     decoded_symbols,     // 已解码源符号数
     total_symbols,       // K
     received_symbols,    // 去重后接收数
     decoded_blocks,      // 已完成块数
     total_blocks,
     frames_seen/dropped/corrupt,
     decoded_fraction,    // 0.0–1.0
     loss_ratio,          // 丢帧率
   }
        │
        ▼ (JSON via JNI)
   Kotlin UI → 实时进度条 + 统计
```
