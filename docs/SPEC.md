# AirFerry Protocol 2 (AF2) 跨端位级契约规格 (SPEC)

> **权威位级线格式与跨端不变量清单**。
> Rust 核心（`core/af2/`、`core/transfer-engine/`）、Web/扩展前端（`apps/web/`）、Android 接收端（`apps/scanner/`）、Windows 接收端（`apps/windows/`）共享。
> 
> - **Wire magic / version**：`AF` / `2`
> - **兼容性**：与 v1 协议（`ET / wire version 1`）完全不兼容，按魔数互斥，无误解析窗口。

---

## 0. 核心架构裁决

1. **自举闭合**：晚加入接收端不依赖“先恢复某对象”即可拿到精确 OTI。
2. **编码实例隔离**：同内容换 T / 换压缩器重发时，未完成 Decoder 结构性不混流（以 128 位 `object_id` 为路由键，包含 `encoded_hash` 并在解码前复算比对）。
3. **独立提交**：Raw Chunk 独立分块、压缩、校验、落盘，支持跨重启与跨编码实例复用。
4. **位级严谨**：所有长度、加法、乘法、偏移、`ceil_div` 在切片或分配前必须经 checked arithmetic 防御。
5. **哈希基准**：采用 **BLAKE3-256 单算法**（Rust `blake3` crate 唯一权威，FFI 跨端复用，空输入摘要 `af1349b9...`）。

---

## 1. 目标与非目标

### 1.1 目标
1. 文件、UTF-8 文字、目录、多文件包采用统一的 Entry 模型，废除旧式魔数嗅探；
2. 用户选择内容后自动分块、压缩、编码、循环播放，无需手动换段；
3. 每个 Raw Chunk 独立恢复、解压、校验、落盘、跨重启复用；
4. 同内容换 T / codec / 压缩参数重发：已完成 Chunk 复用，未完成 Decoder 结构性不混流；
5. 一切不可信输入在进入第三方解码器前 fail-closed 验尽；
6. 协议演进通过 Critical/Optional TLV 与注册表扩展，消除固定尾部追加。

### 1.2 非目标
- 不提供双向 ACK/NACK（完全单向光学信道）；
- 不做符号级 Decoder 持久化（仅做 Chunk 级持久化）；
- 不提供对 v1 构件的升级兼容。

---

## 2. 分层模型

```text
内容层   Manifest：Entry、规范路径、Entry Hash、Chunk Hash Table
分块层   Canonical Content Stream → 固定大小 Raw Chunk (默认 8 MiB)
压缩层   每个 Raw Chunk 独立选择 RAW / Zstd / XZ
FEC 层   Manifest 与每个 Encoded Chunk 各为一个 RaptorQ Object（RFC 6330）
帧层     ROOT / OBJECT_META / SYMBOL
物理层   每帧一个 QR；多码布局并行承载多帧
```

- **Entry**：文件、UTF-8 文字或目录。
- **Canonical Content Stream**：按规范路径字节序升序，顺序无缝拼接全部非目录 Entry 内容。
- **Raw Chunk**：该流的固定范围切片。**Encoded Chunk**：Raw Chunk 经 RAW/Zstd/XZ 编码后的字节。
- **Object**：独立 RaptorQ 对象；Manifest 是一个，每个 Encoded Chunk 各是一个。
- **Broadcast Instance**：以固定 T 与一组固定 Object Meta 连续播放一个 Transfer 的一次运行。
- **Epoch**：调度器遍历全部 Chunk 一轮；后续 Epoch 发送各对象未用过的新 Repair ESI。

---

## 3. 基础编码约定

- 多字节整数一律大端序（Big-Endian）；`u24` 为 3 字节大端无符号数。
- 基础哈希：**BLAKE3-256**（记作 `H(...)`，输出 32B，空输入摘要 `af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262`）。
- 帧校验：CRC-32/ISO-HDLC (IEEE)（自检 `CRC32("123456789") = 0xCBF43926`）。
- 字符串：严格 UTF-8；路径分隔符固定 `/`；域标签为精确 ASCII 字节。
- `Trunc128(h)`：取 32B 哈希前 16B。

---

## 4. 三层身份体系

| ID | 位宽 | 回答的问题 | 编码参数变化时 |
|---|---:|---|---|
| **Content ID** | 256 | 逻辑内容与路径结构指纹 | 保持不变 |
| **Transfer ID** | 128 | 该内容按指定 `chunk_raw_size` 切分的身份 | 仅块大小变化才变 |
| **Object ID** | 128 | 某 Object（Manifest 或 Encoded Chunk）的一次精确编码 | 任意参数变化即变 |

### 4.1 Content ID
```text
content_id = H(
    ASCII("AF2/content/v1")
    || entry_count:u32
    || repeated { kind:u8 || path_len:u16 || path || size:u64 || entry_hash:[32] }
)
```
*注：目录 `size = 0`、`entry_hash = H(空)`。mtime、MIME、权限不进身份，仅作为 TLV 注解。*

### 4.2 Transfer ID
```text
transfer_id = Trunc128(H(
    ASCII("AF2/transfer/v1") || manifest_hash:[32] || chunk_raw_size:u32
))
```

### 4.3 Object ID
```text
object_id = Trunc128(H(
    ASCII("AF2/object/v1")
    || transfer_id:[16] || role:u8 || object_index:u32
    || codec_id:u8 || fec_id:u8 || oti:[12] || encoded_hash:[32]
))
```

---

## 5. Wire Frame 格式

```text
[Header 26 B][Payload Area T B][Frame CRC32 4 B]     总开销 30 B
```

| 偏移 | 长度 | 字段 | 说明 |
|---:|---:|---|---|
| 0 | 2 | magic | ASCII `AF` (`0x4146`) |
| 2 | 1 | wire_version | 固定 `2` |
| 3 | 1 | frame_type | `1`=ROOT, `2`=OBJECT_META, `3`=SYMBOL |
| 4 | 16 | object_id | SYMBOL/META = Object ID；ROOT = Transfer ID |
| 20 | 2 | body_len | Payload Area 内有效字节数 |
| 22 | 1 | sbn | RaptorQ SBN（控制帧必须 0） |
| 23 | 3 | esi | RaptorQ ESI，u24 BE（控制帧必须 0） |
| 26 | T | payload_area | 有效 body + 零填充至 T 字节 |
| 26+T| 4 | frame_crc32 | 覆盖 0..26+T 字节的 IEEE CRC32 |

- `T`: `256 ≤ T ≤ 2400` 且 `T % 8 == 0`；一个 Broadcast Instance 内恒定。
- SYMBOL 帧 `body_len == T`；控制帧 `body_len ≤ T` 且 `body_len..T` 填充 0。

---

## 6. 控制记录格式

### 6.1 Root Record (`AFR2`, 112 B + TLV)
| 偏移 | 长度 | 字段 |
|---:|---:|---|
| 0 | 4 | magic ASCII `AFR2` |
| 4 | 1 | schema = 1 |
| 5 | 1 | flags = 0 |
| 6 | 2 | fixed_len = 112 |
| 8 | 2 | extensions_len |
| 10 | 2 | reserved = 0 |
| 12 | 32 | content_id |
| 44 | 16 | manifest_object_id |
| 60 | 32 | manifest_hash |
| 92 | 8 | total_raw_size |
| 100 | 4 | entry_count |
| 104 | 4 | chunk_count |
| 108 | 4 | chunk_raw_size (默认 8 MiB) |

### 6.2 Object Meta Record (`AFO2`, 112 B + TLV)
| 偏移 | 长度 | 字段 |
|---:|---:|---|
| 0 | 4 | magic ASCII `AFO2` |
| 4 | 1 | schema = 1 |
| 5 | 1 | role: `1`=MANIFEST, `2`=CHUNK |
| 6 | 2 | fixed_len = 112 |
| 8 | 2 | extensions_len |
| 10 | 2 | reserved = 0 |
| 12 | 16 | transfer_id |
| 28 | 4 | object_index |
| 32 | 1 | codec_id (0=RAW, 1=Zstd, 2=XZ) |
| 33 | 1 | fec_id (固定 1 = RaptorQ RFC 6330) |
| 34 | 2 | reserved = 0 |
| 36 | 12 | oti (RFC 6330 12B 线格式) |
| 48 | 32 | raw_hash |
| 80 | 32 | encoded_hash |

### 6.3 Manifest Header (`AFM2`, 80 B)
- 恒为 RAW 不压缩，上限 16 MiB。
- 结构：`[Header 80 B][Entry Records][Chunk Hash Table][Manifest TLVs]`。
- **Entry Record (60 B + path + TLV)**：`kind` (1=FILE, 2=UTF8_TEXT, 3=DIRECTORY)、`content_offset`、`content_size`、`content_hash`。
- **路径约束**：Unicode NFC、严格 UTF-8、`/` 分隔、禁止 `..` 与绝对路径、总长 ≤ 1024 B、单段 ≤ 255 B。

---

## 7. 压缩编解码与调度

### 7.1 压缩注册表
| codec_id | 算法 | 约束 |
|---:|---|---|
| 0 | RAW | encoded == raw |
| 1 | Zstd | 单 Frame、windowLog ≤ 23 |
| 2 | XZ/LZMA2 | 单 Stream、解码内存 ≤ 128 MiB |

- **接收端 MUST 可解码全部三种 codec**（三端已实现：Native 走 zstd/xz2，Web 走 ruzstd/lzma-rs）；发送端按 §10.1 逐块自选算法，**RAW 恒合法**。
- 严格变小才压缩：压缩结果严格小于原始大小时方可使用压缩，否则必须为 RAW。

### 7.2 标准 Playlist 调度
```text
Bootstrap: ROOT × 4 → MANIFEST META × 4 → up to 32 Manifest Symbols
Each Chunk i: ROOT × 1 → CHUNK i META × 2 → i's source symbols → fresh repair symbols (0.25 K)
Interleave: META 每 ~17 帧广播；ROOT 每 ~31 帧广播；每 ~8 个 Chunk Symbol 插入 1 个 Manifest Symbol
```

---

## 8. 完整性校验链（强制顺序）

```text
① Frame CRC32 
  → ② Header/Meta 边界与预算校验 
  → ③ OTI 校验（先于建 Decoder）
  → ④ object_id + encoded_hash（解码前验证 META，恢复后验证字节）
  → ⑤ 解压窗口/内存/精确长度/尾随校验 
  → ⑥ Chunk Hash（校验 Manifest 表）
  → ⑦ Manifest Hash（校验 ROOT） 
  → ⑧ Entry Hash 
  → ⑨ Content ID 重算
```

---

## 9. 跨端职责分工

- **Rust Core 唯一实现**：帧/ROOT/META/Manifest/TLV 编解码、哈希与三层 ID 派生、路径校验、OTI 验证、状态机、有界解压接口、单一 Receiver Snapshot ABI。
- **宿主层（TS / Kotlin / C#）**：相机与屏幕捕获、QR 灰度解码、文件系统与 IndexedDB 落盘、UI 视图。禁止在宿主语言中镜像线格式协议。

---

## 10. 发送端预处理流水线（SHOULD）

1. **单趟读取**：entry hash、chunk hash、全文 content 派生在同一次读取中完成，禁止为哈希与分块分别通读。
2. **重发免哈希缓存**：发送端本地按 `(规范路径, size, mtime)` 缓存已算好的 entry_hash / chunk 表 / content_id；命中即零预处理直接开播。mtime 仅为本地缓存失效键，不进协议身份。
3. **惰性编码**：Chunk 的压缩与 RaptorQ 编码在播放开始后按 playlist 顺序惰性进行，降低峰值内存。

---

## 11. 断点恢复账本（宿主格式，非 wire）

```text
ledger_version, transfer_id, manifest_hash, content_id(Manifest 后写),
total_raw_size, chunk_raw_size, chunk_count, completed_bitmap, chunk_hash[](Manifest 后写)
```

- **提交顺序**：恢复 Encoded → 验 object_id/encoded_hash → 有界解压 → 验 chunk hash → pwrite → fsync 数据 → 写临时账本 fsync → 原子 rename 账本 → 内存置位。
- **重开复核**：重开任务必须重算已完成位对应范围的 chunk hash，不符位清零（治愈账本虚报）。
- **跨实例复用**：完成位以 `(transfer_id, chunk_index, raw_hash)` 判定，跨 codec、压缩 level、T、修复调度变化均可复用。

---

## 12. 强制资源上限

| 项 | 上限 |
|---|---:|
| T | 256..=2400，8 对齐 |
| Manifest | 16 MiB |
| Entry 数 / 单路径 | 4096 / 1024 B |
| chunk_raw_size | 1..32 MiB 2 的幂（默认 8） |
| chunk_count / 总大小 | 131072 / 4 TiB（`total_raw_size ≥ 1`） |
| 单 Encoded Object | 32 MiB（Manifest 16 MiB） |
| Source Blocks / ESI | 255 / < 2²⁴（触顶停止，跨 Epoch 永不重复） |
| zstd windowLog / XZ 内存 | 23 / 128 MiB |
| 活跃 Decoder | Manifest 1 + Chunk 1 |
| 未知 Object 符号缓存 | **0** |

---

## 13. 跨端能力矩阵

| 端 | 发送端支持 | 接收端支持 | 备注 |
|---|---|---|---|
| Native (Android / Windows) | RAW, Zstd, XZ | RAW, Zstd, XZ | 全功能（C 库绑定 `zstd` / `xz2`） |
| Web (WASM) | RAW, Zstd, XZ | RAW, Zstd, XZ | 全功能（纯 Rust `zrip` / `lzma-rust2` 编码，`ruzstd` / `lzma-rs` 解码） |

> **Web 发送端压缩实现**：Web/WASM 发送端使用纯 Rust 的 `zrip` 与 `lzma-rust2` 编码（`ruzstd` / `lzma-rs` 解码），严格遵守 §7.1"严格变小才压缩"的双端不变量（产物小于原始数据时才使用压缩标签，否则自动使用 RAW）。四端线格式与编解码能力 100% 闭合。
>
> **发送端选优策略（不进线格式，三规则平衡策略）**：发送端在预处理期（`开始传输` 时）对每个 Chunk 用
> `encode_chunk_balanced` 预编码，播放循环零压缩——
> ① **采样跳过**：每 Chunk 前 256 KiB 用 zstd-L1 与 xz-p2 试压，两者都压不到 98% 以下即判不可压缩（媒体/随机数据），直接 RAW、不做全量尝试；
> ② **best-of(zstd-L1, xz-p2)**：可压缩 Chunk 在两档间取小（p2 拿回 xz 大部分压缩率、编码速度约 7 倍于标准档）；
> ③ **速率门控升级**：仅当高压缩档（native 6|EXTREME / wasm 6）预估节省的传输时间大于其编码耗时（按播放速率 R = fps×T×码数 与实测编码吞吐校准），或单 Chunk 传输（≤1 chunk，等待有界）时，才升级到高压缩档。
> 预编码产物经 `PreencodedChunk` 通道进入发送器，核心侧强制校验严格变小不变量；任何预编码失败回退播放期惰性编码（`encode_chunk`），不影响可用性。

---

## 14. TLV 规则（ROOT / META / Manifest / Entry 四作用域）

```text
type:u16 || length:u16 || value          type & 0x8000 = Critical
```

- 同一作用域内 type **严格升序**、不得重复；length 累加与 body_len 必须 checked 后才切片。
- 未知 Optional → 跳过；未知 Critical → 拒绝所在结构并提示升级（fail-closed）。
- `0x4000–0x7FFF` / `0xC000–0xFFFF` 为实验/厂商段。
- 演进判定：新注解 → Optional TLV；新算法/新语义 → 注册表新码点 + Critical TLV；
  帧头布局变化 → wire_version+1。禁止复用已废弃码点。
- 预留方向：Ed25519 签名、分块 AEAD、SHA-256 注册（外部合规核验）、双向确认 Profile、CDC 分块。
- 已知 Entry 注解 TLV（均 Optional）：`0x0101` mtime_ms(u64)、`0x0102` unix_mode(u32)、
  `0x0103` mime(UTF-8 ≤ 255B)、`0x0104` type_class(u8，纯 UI 提示，非信任来源)。

