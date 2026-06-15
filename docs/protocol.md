# 传输协议规范 (Protocol Specification)

## 概述

EasyTransfer 使用单向光学信道：发送端连续播放二维码视频流，接收端实时扫描。协议设计为**无握手、无确认、可随时加入**。

## 会话 (Session)

每个文件传输对应一个**会话**，由 128-bit **会话 ID** 唯一标识。

### 会话 ID 派生

会话 ID 由文件身份确定性派生（FNV-1a 128-bit）：

```
session_id = FNV1a_128(
    UTF8(文件名),
    LE64(文件大小),
    LE64(修改时间毫秒),
    内容指纹  // FNV1a_64(前1KB + 后1KB)
)
```

同一文件重复发送产生相同会话 ID → 接收端可识别并断点恢复。

## 帧格式 (Frame Format)

每帧 = `[Header 60B][Payload 1024B][Footer 4B]` = **1088 字节**。

所有多字节整数为大端序（network order）。

### Header (60 字节)

| 偏移 | 长度 | 字段 | 类型 | 说明 |
|------|------|------|------|------|
| 0 | 2 | magic | u16 | `0x4554` (ASCII "ET")，帧同步标识 |
| 2 | 1 | version | u8 | `1` |
| 3 | 1 | flags | u8 | 位域；bit0=`FLAG_DESCRIPTOR` |
| 4 | 16 | session_id | u128 | 会话 ID（大端） |
| 20 | 4 | sbn | u32 | RaptorQ 源块号 |
| 24 | 4 | esi | u32 | 编码符号 ID（源< K，修复≥K） |
| 28 | 4 | total_blocks | u32 | 源块总数 |
| 32 | 4 | total_symbols | u32 | 源符号总数 K |
| 36 | 4 | symbol_size | u32 | 符号大小 T（=1024） |
| 40 | 8 | frame_index | u64 | 单调帧序号（统计用） |
| 48 | 8 | timestamp_ms | u64 | 发送端时间戳（UNIX 毫秒） |
| 56 | 4 | payload_crc32 | u32 | 载荷 CRC32 |

### Payload (1024 字节)

- **数据帧**：一个 RaptorQ 符号（源符号或修复符号）
- **描述符帧**（`flags & 0x01 != 0`）：会话元数据（见下文）

### Footer (4 字节)

| 偏移 | 长度 | 字段 | 类型 | 说明 |
|------|------|------|------|------|
| 60 | 4 | frame_crc32 | u32 | 覆盖 Header+Payload 的整帧 CRC32 |

## 双层 CRC 校验

1. **payload_crc32**（Header 内）：校验载荷完整性
2. **frame_crc32**（Footer）：校验整帧完整性（Header + Payload）

任一校验失败 → 丢弃该帧，依赖 RaptorQ 冗余恢复。

## 描述符帧 (Descriptor Frame)

描述符帧携带**权威的对象元数据**（OTI + 每块符号数），使晚加入的接收端能构建解码器。

发送端每隔 N 帧（默认 30）插入一个描述符帧。`flags` 的 bit0 置位。

### 描述符载荷布局（1024B 内）

**协议 v3 格式**（当前版本）：

| 偏移 | 长度 | 字段 | 说明 |
|------|------|------|------|
| 0 | 1 | magic | `0xD5` |
| 1 | 1 | version | `3` |
| 2 | 2 | num_blocks | u16 BE |
| 4 | 8 | transfer_length | u64 BE（压缩后大小） |
| 12 | 4 | symbol_size | u32 BE |
| 16 | 12 | oti_bytes | RFC 6330 OTI（12B 线格式） |
| 28 | 16×B | blocks[] | 每块：sbn(u32) + num_source_symbols(u32) + block_length(u64) |
| 28+16B | 1 | compression | u8：`0`=无压缩, `1`=Zstd, `2`=XZ |
| 29+16B | 8 | compressed_size | u64 BE（压缩后负载大小） |
| 37+16B | 4 | original_crc32 | u32 BE（原始文件 CRC32） |
| 41+16B | 变长 | filename | UTF-8 文件名（剩余字节） |

**v3 扩展尾部**（compression + compressed_size + original_crc32 + filename）按可用长度解析，因此 v2 接收端可读取 v3 描述符（忽略尾部扩展）。

固定开销 28 字节 + 每块 16 字节 + v3 尾部 13 字节。对数百块以内的文件，轻松装入 1024B 符号。

## 压缩 (Compression)

发送端在 RaptorQ 编码前对文件进行压缩，压缩算法标签由描述符帧携带（`compression` 字段），接收端在 RaptorQ 恢复后按标签解压。

### 算法标签

| 标签值 | 算法 | 说明 |
|--------|------|------|
| `0` | 无压缩 (Raw) | 原始字节直传 |
| `1` | Zstd | 压缩等级 22（最大） |
| `2` | XZ / LZMA2 | 浏览器端压缩等级 9，Rust 解压端兼容 |

### 三算法选优策略（浏览器端）

浏览器发送端对每个文件同时运行多个压缩候选，选取最小结果：

1. **Raw**：始终作为候选
2. **Zstd Lv22**：始终运行
3. **Xz Lv9**：仅当 Zstd 压缩率 < 95% 时运行（95% early-exit 启发式，跳过已压缩文件如 JPEG/MP4 的慢速 Xz 压缩）

最终选取所有已运行候选中体积最小的算法，标签写入描述符帧。

## RaptorQ 符号坐标

| 符号类型 | ESI 范围 | 说明 |
|---------|---------|------|
| 源符号 | `[0, K_block)` | 原始数据符号 |
| 修复符号 | `[K_block, ∞)` | 喷泉码生成的冗余符号 |

接收端只需收集足够多的**独立**符号（≥ K_block）即可解码，与顺序无关。

## 冗余与发射计划

发送端的发射计划（一轮）：

1. **所有源符号**：按块顺序输出（sbn=0 的全部源符号，再 sbn=1...）
2. **修复符号**：跨块轮询输出（block0 的第0个修复，block1 的第0个修复，...）

每轮的修复符号数 = `K × redundancy_pct / 100`。发射计划无限循环，接收端可在任意时刻加入。

## 断点恢复

接收端将以下状态序列化到磁盘：
- `session_id`
- `ObjectMeta`（OTI + 每块 K）
- 每块已接收的 ESI 集合
- 已存储的符号字节

重启后加载状态，重新构建 Decoder 并回放已存储符号 → 无损续传。
