# AirFerry Protocol 2（AF2-IF）独立综合最终版

> 综合者：Claude Fable 5（独立评审轮，2026-08-16）
> 状态：**已实现**（2026-08-17 收尾，Rust 核心 + 三端接入完成；权威规格已合入 `docs/SPEC.md`）
> Wire magic / version：`AF` / `2`
> 兼容性：与现行 `ET / wire version 1` 完全不兼容，两代按 magic 互斥，无误解析窗口
>
> 本文是设计冻结稿的历史记录。**线上权威规格是 [`docs/SPEC.md`](../docs/SPEC.md) 与
> `core/af2/` 代码**；实现期裁定与落地（E1 宿主形态、验收矩阵落地、Web 纯 Rust 压缩等）
> 见 `todo/v2版本升级计划.md` 的"执行注记"表。

---

## 0. 裁决摘要（为什么是这个形状）

评审只看四个硬问题，其余全是风格：

1. **自举闭合**：晚加入接收端必须能不依赖"先恢复某对象"拿到精确 OTI。
   → 淘汰 DeepSeek Pro（Manifest 的 K 无处获得）与 Vanguard（Manifest 自身无自举路径）。
2. **编码实例隔离**：同内容换 T / 换压缩器重发时，未完成 Decoder 不得混入两套符号。
   → 淘汰一切以 `(transfer_id, chunk_index)` 为路由键的方案（Claude 8B oid、Kimi、DeepSeek Pro）：
   循环重播的旧实例符号会持续中毒新 Decoder，事后 hash 只能发现、不能阻止反复中毒。
3. **独立提交**：块必须能独立解压、校验、落盘。
   → 淘汰 solid 压缩主路径（Kimi、GLM）与 LZ-Chain 顺序依赖（Vanguard）。
4. **位级严谨**：偏移/上限/公式自洽。
   → 淘汰 Gemini（头长与字段矛盾、算法多选不可互操作）。

结论：**GPT-5 的 ROOT + OBJECT_META + SYMBOL 三帧骨架**是唯一四项全过的结构，作为主干；
融合 Claude 的 Manifest/Entry/路径/账本细节、Kimi/DeepSeek 的自动 playlist、GLM 的 TLV 演进矩阵、
Gemini 的 type_class/MIME 注解。对 GPT 原稿修正一处实质缺陷：**`encoded_hash` 上线进 OBJECT_META**，
使 object_id 在解码前即可复算验证，而非恢复后才能事后核对。

基础哈希定为 **BLAKE3-256 单算法**（采 Claude/Vanguard 提案的方向，但拒绝其 hash_alg
多选注册表——单向信道无法协商，"可选"即"全都必须实现"）：发送端预处理必须通读全文，
多线程 BLAKE3 把预处理时间压到磁盘/File API 读速的物理地板，SHA-256 在 WASM 无硬件加速
是真实的用户等待。配套 §9.3 的单趟流水线与重发免哈希缓存。

首版明确不采纳（均留 TLV/注册表扩展位）：CRC32C（帧 CRC 不在任何关键路径，~300 KB/s
信道下硬件指令收益不可测量，不值得三端迁移）、SHA-256（降级为注册表备选）、LZ4、
LZ-Chain、inline Manifest、盲缓存、加密/签名。理由统一：不为边际收益引入第二条路径。

---

## 1. 目标与非目标

AF2 面向完全离线、单向、无握手、可随时加入的二维码广播传输。必须做到：

1. 文件、UTF-8 文字、目录、多文件包用同一显式 Entry 模型，废除 `ETTEXTv1`/`ETBUNDL1` 魔数嗅探；
2. 用户选择内容后自动分块、压缩、编码、循环播放，无手动换段；
3. 每个 Raw Chunk 独立恢复、解压、校验、落盘、跨重启复用；
4. 同内容换 T / codec / 压缩参数重发：已完成 Chunk 复用，未完成 Decoder 结构性不混流；
5. 一切不可信输入在进入第三方解码器前 fail-closed 验尽（panic=abort 生命线）；
6. 演进只走 Critical/Optional TLV 与注册表，永不再有 descriptor v3/v5 式固定尾部追加。

不提供：双向 ACK/NACK、符号级 Decoder 持久化、对 v1 任何构件的升级解析、身份认证与机密性
（后两者走未来 Critical Profile）。

## 2. 分层与术语

```text
内容层   Manifest：Entry、规范路径、Entry Hash、Chunk Hash Table
分块层   Canonical Content Stream → 固定大小 Raw Chunk
压缩层   每个 Raw Chunk 独立选择 RAW / Zstd / XZ
FEC 层   Manifest 与每个 Encoded Chunk 各为一个 RaptorQ Object（RFC 6330）
帧层     ROOT / OBJECT_META / SYMBOL
物理层   每帧一个 QR；多码布局只是并行承载多帧
```

- **Entry**：文件、UTF-8 文字或目录。
- **Canonical Content Stream**：按规范路径字节序升序，顺序无缝拼接全部非目录 Entry 内容。
- **Raw Chunk**：该流的固定范围切片。**Encoded Chunk**：Raw Chunk 经 RAW/Zstd/XZ 编码后的字节。
- **Object**：独立 RaptorQ 对象；Manifest 是一个，每个 Encoded Chunk 各是一个。
- **Broadcast Instance**：以固定 T 与一组固定 Object Meta 连续播放一个 Transfer 的一次运行。
- **Epoch**：调度器遍历全部 Chunk 一轮；后续 Epoch 只发各对象未用过的新 Repair ESI。

## 3. 基础编码约定

- 多字节整数一律大端序；`u24` 为 3 字节大端无符号数。
- 基础哈希一律 **BLAKE3-256**（本文记作 `H(...)`，输出 32B）。实现自检：空输入摘要
  `af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262`；外部核验用 `b3sum`。
  唯一实现放 Rust 核心（`blake3` crate），三端经 FFI/WASM 复用，禁止镜像实现。
  SHA-256 不在基础协议中，未来如需（外部合规核验等）走 Critical TLV 注册。
- CRC 为 CRC-32/ISO-HDLC（IEEE），与现行 `crc32fast` 生态一致；自检 `CRC32("123456789") = 0xCBF43926`。
  不采用 CRC32C：帧 CRC 工作量随信道速率（≤~300 KB/s）走，硬件指令收益不可测量，
  而 IEEE 三端已有实现。
- 字符串严格 UTF-8；路径分隔符固定 `/`；域标签为精确 ASCII 字节，无隐式 NUL。
- `Trunc128(h)` 取 32B 哈希前 16B（线序）。
- 所有长度加法、乘法、偏移、`ceil_div` 必须 checked arithmetic 后才切片或分配。

## 4. 三层身份

三个 ID 回答三个不同问题，禁止合并：

| ID | 位宽 | 回答 | 编码参数变化时 |
|---|---:|---|---|
| Content ID | 256 | 逻辑内容与路径结构是什么 | 不变 |
| Transfer ID | 128 | 该内容按多大 Raw Chunk 切分 | 不变（仅 chunk_raw_size 变才变） |
| Object ID | 128 | 某 Object 的这一次精确编码 | OTI/codec/编码字节任一变即变 |

### 4.1 Content ID

Entry 按规范路径 UTF-8 字节严格升序排列后：

```text
content_id = H(
    ASCII("AF2/content/v1")
    || entry_count:u32
    || repeated { kind:u8 || path_len:u16 || path || size:u64 || entry_hash:[32] }
)
```

目录的 `size = 0`、`entry_hash = H(空)`。**mtime、MIME、权限永不进身份**（v1 教训：
touch 即断点失效）；它们是 Entry TLV 注解。

### 4.2 Transfer ID

```text
transfer_id = Trunc128(H(
    ASCII("AF2/transfer/v1") || manifest_hash:[32] || chunk_raw_size:u32
))
```

同 Manifest 同块长重发 → 同 Transfer ID → 账本命中续传；换压缩器、换 T、换修复比例均不影响。

### 4.3 Object ID（本版核心防线）

```text
object_id = Trunc128(H(
    ASCII("AF2/object/v1")
    || transfer_id:[16] || role:u8 || object_index:u32
    || codec_id:u8 || fec_id:u8 || oti:[12] || encoded_hash:[32]
))
```

`encoded_hash = H(Encoded Object 精确字节)`，由 OBJECT_META **在线携带**（§8）。
接收端收到 META 即复算 object_id 并与帧头比对（解码前绑定）；对象恢复后再验编码字节哈希
（解码后绑定）。不同压缩器输出、不同 OTI 必得不同 Object ID —— 混流在路由层就不可能发生。

## 5. Wire Frame

```text
[Header 26 B][Payload Area T B][Frame CRC32 4 B]     总开销 30 B（v1 为 64 B）
```

| 偏移 | 长度 | 字段 | 说明 |
|---:|---:|---|---|
| 0 | 2 | magic | ASCII `AF`（`0x4146`） |
| 2 | 1 | wire_version | 固定 `2`；未知即拒 |
| 3 | 1 | frame_type | `1`=ROOT `2`=OBJECT_META `3`=SYMBOL；未知丢帧 |
| 4 | 16 | object_id | SYMBOL/META = Object ID；ROOT = Transfer ID |
| 20 | 2 | body_len | Payload Area 内有效字节数 |
| 22 | 1 | sbn | RaptorQ SBN（控制帧必须 0） |
| 23 | 3 | esi | RaptorQ ESI，u24 BE（控制帧必须 0） |

- `T = 帧总长 − 30`，必须 `256 ≤ T ≤ 2400` 且 `T % 8 == 0`；一个 Broadcast Instance 内恒定。
- SYMBOL 的 `body_len == T`；控制帧 `body_len ≤ T` 且 `body_len..T` 必须全零。
- Frame CRC32 覆盖 Header + 完整 Payload Area（含零填充）。CRC 只查扫码误码，不认证。
- v1 的 `total_blocks / total_symbols / symbol_size / frame_index / timestamp_ms / payload_crc32`
  全部删除：权威值在 META，T 由帧长隐式给出，统计接收端本地可测，双 CRC 覆盖重叠。
- 用户改 T 必须开新 Broadcast Instance：已提交 Chunk 保留，未完成 Decoder 清空（Object ID 已变）。

**关于 16B object_id 的开销**：较 8B 短 ID 多付 8B/帧（T=1400 时 0.56%），换取 §4.3 的
结构性防混流。这是本版与 Claude/Kimi 提案的核心分歧，判定为值得。

## 6. Root Record（ROOT 帧载荷）

接收端锁定 Transfer、建立资源预算、定位 Manifest 的入口。固定 112 B + TLV：

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
| 60 | 32 | manifest_hash（未压缩 Manifest 字节） |
| 92 | 8 | total_raw_size |
| 100 | 4 | entry_count |
| 104 | 4 | chunk_count |
| 108 | 4 | chunk_raw_size |

校验：`body_len == fixed_len + extensions_len`；`1 ≤ entry_count ≤ 4096`；
`chunk_raw_size ∈ {1,2,4,8,16,32} MiB`（2 的幂，标准默认 **8 MiB**）；
`chunk_count == ceil(total_raw_size / chunk_raw_size)` 且 ≤ 131072；`total_raw_size ≤ 4 TiB`。

- 同一 Transfer ID 的 ROOT 语义字段必须完全一致：首个合法 ROOT 冻结，冲突帧丢弃计数。
- `manifest_object_id` 是传输参数：换 T 重播时允许变化——语义字段一致而它变化时，
  保留账本、丢弃旧的未完成 Manifest Decoder、接受新 ID。
- **无合法 ROOT 时不建任何 Decoder、不缓存任何 SYMBOL**。盲缓存被拒绝的理由：
  预算封顶后它对大传输退化为"缓存前 32 MiB 然后全丢"，换来的启动收益不可证且引入 OOM 面；
  周期 ROOT/META + 持续新鲜修复符号已保证晚加入者线性收敛。

## 7. Manifest

独立 RaptorQ Object，**恒为 RAW 不压缩**（Chunk 哈希表本身不可压，固定 RAW 消灭启动分支）。
上限 16 MiB。

### 7.1 Manifest Header（80 B）

| 偏移 | 长度 | 字段 |
|---:|---:|---|
| 0 | 4 | magic ASCII `AFM2` |
| 4 | 1 | schema = 1 |
| 5 | 1 | flags = 0 |
| 6 | 2 | fixed_len = 80 |
| 8 | 4 | manifest_len（四区总和） |
| 12 | 4 | entry_count |
| 16 | 4 | chunk_count |
| 20 | 4 | chunk_raw_size |
| 24 | 8 | total_raw_size |
| 32 | 32 | content_id |
| 64 | 4 | entries_len |
| 68 | 4 | chunk_hashes_len（== chunk_count × 32） |
| 72 | 4 | extensions_len |
| 76 | 4 | reserved = 0 |

布局：`[Header][Entry Records][Chunk Hash Table][Manifest TLVs]`。
恢复后必须重算 manifest_hash / content_id / transfer_id 并与 ROOT 交叉验证。

### 7.2 Entry Record（固定 60 B + path + TLV）

| 偏移 | 长度 | 字段 |
|---:|---:|---|
| 0 | 4 | record_len（== 60 + path_len + extensions_len） |
| 4 | 1 | kind：`1`=FILE `2`=UTF8_TEXT `3`=DIRECTORY |
| 5 | 1 | flags = 0 |
| 6 | 2 | reserved = 0 |
| 8 | 2 | path_len |
| 10 | 2 | extensions_len |
| 12 | 8 | content_offset |
| 20 | 8 | content_size |
| 28 | 32 | content_hash |
| 60 | … | path ‖ Entry TLVs |

**路径规则**（违反任一 → 整个 Manifest 拒收）：Unicode NFC、严格 UTF-8、相对路径 `/` 分隔；
禁空路径、空分量、`.`、`..`、前导 `/`、反斜杠、NUL、C0 控制符；总长 ≤ 1024 B、单段 ≤ 255 B；
Manifest 内路径字节级不重复。接收端落盘前另做平台化清洗（Windows 保留名、大小写折叠冲突
确定性加后缀），清洗只改保存名、不改校验对象，且不得逃出目标目录。

**内容规则**：Entry 按路径字节序严格升序；非目录 Entry 内容按此序无缝拼接成 Canonical
Content Stream（`content_offset` 必须等于前一非目录 Entry 的结束偏移，末尾等于
`total_raw_size`）；DIRECTORY 的 offset/size = 0、hash = H(空)；UTF8_TEXT 恢复后必须
通过严格 UTF-8 校验，失败即整传校验失败，不降级猜测。

**Entry 标准 TLV**（均 Optional）：`0x0101` mtime_ms(u64)、`0x0102` unix_mode(u32)、
`0x0103` mime(UTF-8 ≤ 255B)、`0x0104` type_class(u8，unknown/text/image/audio/video/
archive/document/executable —— 纯 UI 提示，不是信任来源)。

### 7.3 Chunk Hash Table

每项 32 B，索引位置隐含：

```text
chunk_hash[i] = H(stream[i × chunk_raw_size .. min(total, (i+1) × chunk_raw_size)])
```

允许 Manifest 完成前把过了 META 自校验的 Chunk 写入暂存，但发布最终文件前必须与本表复核；
不匹配的位清零重收。

## 8. Object Meta Record（OBJECT_META 帧载荷）

为 Manifest 或某个 Chunk 提供建 Decoder 的全部信息。固定 112 B + TLV：

| 偏移 | 长度 | 字段 |
|---:|---:|---|
| 0 | 4 | magic ASCII `AFO2` |
| 4 | 1 | schema = 1 |
| 5 | 1 | role：`1`=MANIFEST `2`=CHUNK |
| 6 | 2 | fixed_len = 112 |
| 8 | 2 | extensions_len |
| 10 | 2 | reserved = 0 |
| 12 | 16 | transfer_id |
| 28 | 4 | object_index（Manifest 为 0；Chunk 为 chunk_index） |
| 32 | 1 | codec_id（§10） |
| 33 | 1 | fec_id（固定 `1` = RaptorQ RFC 6330） |
| 34 | 2 | reserved = 0 |
| 36 | 12 | oti（RFC 6330 12B 线格式） |
| 48 | 32 | raw_hash（解码解压后原始字节；Chunk 时 == Chunk Hash Table 对应项） |
| 80 | 32 | encoded_hash（Encoded Object 精确字节） |

规则：

- 接收端收到 META 即按 §4.3 复算 object_id，与帧头不符 → 丢弃计数。**这是对 GPT 原稿的
  修正**：原稿 encoded_hash 不上线，object_id 只能恢复后验证，解码期间无法拒收伪 META。
- Manifest 必须 `codec_id = RAW`，其 raw_hash == ROOT.manifest_hash（此时 encoded == raw）。
- OTI 是 FEC 参数唯一事实源：块数、每块 K、块长按 RFC 6330 §4.4.1.2 确定性推导，**不传块表**；
  OTI transfer length = Encoded Object 精确字节数，发送端不得手工补齐符号边界。
- OTI Symbol Size 必须等于当前 T；SBN 合法域 0..=254；ESI < 2²⁴。
- 全部 OTI/长度/溢出/内存预算校验必须在调用第三方 RaptorQ 库前完成。
- 同一 object_id 的首个合法 META 冻结；后续必须逐字节一致。
- Chunk 的规范 raw offset/length 由 ROOT 推导，不重复上线。

## 9. RaptorQ 与发射调度

### 9.1 编码

每对象独立编码。Manifest Encoded ≤ 16 MiB；Chunk Encoded ≤ chunk_raw_size ≤ 32 MiB
（RAW 时 encoded == raw，压缩仅在严格变小时使用，故恒成立）。块内源符号一遍
（esi-major 跨块轮询），之后持续新鲜修复符号（每块 ESI 单调递增永不重复，触 2²⁴ 停止）——
v1 已验证的反 coupon-collector 机制原样保留。`redundancy_pct` 仅作 UI 时长估算。

### 9.2 标准自动 playlist（发送端策略，SHOULD）

```text
Bootstrap:  ROOT × 4 → MANIFEST META × 4 → 最多 32 个 Manifest Symbol
每个 Chunk i:
  ROOT ×1 → CHUNK i META × 2 → i 的全部源符号 → 新鲜修复（默认 0.25K）
  期间：每 ~17 帧重复当前 META；每 ~31 帧重复 ROOT；
        Manifest 未完成前每 ~8 个 Chunk Symbol 插 1 个 Manifest Symbol
Epoch 结束：进入下一 Epoch，全对象只用未用过的新 Repair ESI，循环至用户停止
```

17 与 31 均与 2/4 多码布局互质（v1 教训：控制帧必须轮转全部物理码位）。
首帧必为 ROOT。发送端无从得知接收完成——默认循环播放，用户在接收端显示完成后停止；
反向确认属未来独立双向 Profile。

### 9.3 发送端预处理流水线（SHOULD，UX 关键）

内容寻址身份决定了**首帧发出前必须通读全文**（ROOT 依赖 content_id，后者依赖全部
entry/chunk hash）——这是结构性的，实现必须把预处理压到 I/O 物理地板：

1. **单趟读取**：entry hash、chunk hash、全文 content 派生、压缩候选评估在同一次读取
   中完成，禁止为哈希与压缩分别通读。Chunk 是定长切片，逐 chunk 分发给多 worker/线程
   并行哈希与压缩（BLAKE3 树结构天然支持）；原生端配合多线程 BLAKE3，预处理时间
   ≈ 磁盘读速；浏览器端瓶颈为 `File.stream()` 读速。
2. **重发免哈希缓存**：发送端本地按 `(规范路径, size, mtime)` 缓存已算好的
   entry_hash / chunk 表 / content_id；命中即零预处理直接开播。mtime 在此仅为**本地
   缓存失效键**，不进任何协议身份（不违反 §4.1）；缓存不可信时按未命中回退全量哈希。
3. 压缩与 RaptorQ 编码可在播放开始后按 playlist 顺序惰性进行（Chunk i 的 META 只在
   其编码完成后才可发出），仅哈希是开播前的硬依赖。

## 10. Raw Chunk 与压缩

### 10.1 注册表（单向信道无法协商，三种全为 MUST 实现）

| codec_id | 算法 | 约束 |
|---:|---|---|
| 0 | RAW | encoded == raw |
| 1 | Zstd | 单 Frame、无外部字典、无 skippable/串联/尾随、windowLog ≤ 23 |
| 2 | XZ/LZMA2 | 单 Stream、无外部字典、声明字典 ≤ min(chunk_raw_size, 32 MiB)、解码内存 ≤ 128 MiB、无尾随 |

逐 Chunk 独立选择；仅当压缩结果**严格小于** raw 时允许压缩标签，否则必须 RAW（接收端违反即拒）。
三算法选优 + 70% early-exit 是发送端策略，不进线格式。解压输出上限与最终长度必须**精确等于**
该 Chunk 的规范 raw 长度。

### 10.2 为什么 per-chunk 而非 solid

solid（v1 v5 / Kimi / GLM）多 1–2% 压缩率，但任一段不可独立解压：网页端必须整流在内存、
崩溃恢复粒度是整个传输、换压缩器重发废掉全部已收段。per-chunk 用可忽略的压缩率损失
（需分块的大文件多为已压缩二进制，选优本就落 RAW）换取独立提交、O(chunk) 内存、
`pwrite` 落盘与跨编码实例的账本复用。Vanguard 的 LZ-Chain 折中方案被拒：块间依赖使乱序
完成与崩溃恢复复杂化，收益未经实测。默认 chunk_raw_size 取 **8 MiB**（较 16 MiB 收紧：
网页端峰值内存减半、断点重扫粒度细一倍，Manifest 哈希表代价仅 32B/chunk）。

## 11. 接收状态机

```text
Idle ──合法 ROOT──► Locked
Locked ├─ MANIFEST META ─► DecodeManifest ─recovered+全验─► ManifestReady
       └─ CHUNK META ────► DecodeChunk（可先于 Manifest）
DecodeChunk recovered:
  验 encoded_hash 与 object_id → 有界解压 → 验精确长度 → 验 chunk hash
  → pwrite 至 chunk_index × chunk_raw_size → fsync → 账本原子提交
ManifestReady + 全部 Chunk 完成:
  逐 Entry hash → 重算 Content ID → 物化文件/文字/目录 → 原子发布 → Done
```

资源策略：Manifest Decoder ≤ 1，活跃 Chunk Decoder ≤ 1（共 ≤ 2）；发送端切换 Chunk 时可
丢弃未完成的旧 Decoder（等下一 Epoch，最多损失一个 Chunk 的扫码进度）；已完成对象的重复
META/SYMBOL 快速忽略；未知 object_id 的 SYMBOL 直接丢弃、零缓存。会话失配防抖沿用 v1
（连续 3 个一致异 Transfer ROOT 才换锁；数据帧永不触发换锁）。

## 12. 断点恢复账本（宿主格式，非 wire）

```text
ledger_version, transfer_id, manifest_hash, content_id(Manifest 后写),
total_raw_size, chunk_raw_size, chunk_count, completed_bitmap, chunk_hash[](Manifest 后写)
```

提交顺序（每步之间崩溃安全）：恢复 Encoded → 验 object_id/encoded_hash → 有界解压 →
验 chunk hash → pwrite → fsync 数据 → 写临时账本 fsync → 原子 rename → 内存置位。
允许重复写同一 Chunk，禁止"账本完成、数据未落盘"。重开任务必须重算已完成位对应范围的
chunk hash，不符位清零（治愈账本虚报）。完成位以 `(transfer_id, chunk_index, raw_hash)`
判定——**跨 codec、压缩 level、T、修复调度变化均可复用**。Native 用稀疏文件 + positioned
write；Web 用 IndexedDB/OPFS 事务，不得以页面内存为唯一恢复状态。入库用 transfer_id 派生的
稳定历史 ID 保证崩溃重试幂等；账本完备而入库被打断时触发幂等再归档。

## 13. 完整性校验链（顺序强制）

```text
① Frame CRC32 → ② Header/Meta 边界与预算 → ③ OTI 全验（先于建 Decoder）
→ ④ object_id + encoded_hash（解码前绑定 META，恢复后绑定字节）
→ ⑤ 解压窗口/内存/精确长度/尾随 → ⑥ Chunk Hash（对 Manifest 表）
→ ⑦ Manifest Hash（对 ROOT） → ⑧ Entry Hash → ⑨ Content ID 重算
```

BLAKE3 保完整不保真实：主动攻击者可整套伪造，来源真实性属未来 Ed25519 Critical TLV。

## 14. TLV 规则（ROOT / META / Manifest / Entry 四作用域）

```text
type:u16 || length:u16 || value          type & 0x8000 = Critical
```

- 未知 Optional → 跳过；未知 Critical → 拒绝所在结构并提示升级（fail-closed）。
- type 升序、同作用域不重复；length 累加与 body_len 必须 checked 后才切片。
- `0x4000–0x7FFF` / `0xC000–0xFFFF` 为实验/厂商段。
- 演进判定矩阵（采自 GLM）：新注解 → Optional TLV；新算法/新语义 → 注册表新码点 +
  Critical TLV；帧头布局变化 → wire_version+1。禁止复用已废弃码点（v1 的 v4 教训）。
- 预留方向：Ed25519 签名、分块 AEAD、SHA-256 注册（外部合规核验场景）、双向确认 Profile、CDC 分块。

## 15. 强制资源上限

| 项 | 上限 |
|---|---:|
| T | 256..=2400，8 对齐 |
| Manifest | 16 MiB |
| Entry 数 / 单路径 | 4096 / 1024 B |
| chunk_raw_size | 1..32 MiB 2 的幂（默认 8） |
| chunk_count / 总大小 | 131072 / 4 TiB |
| 单 Encoded Object | 32 MiB（Manifest 16 MiB） |
| Source Blocks / ESI | 255 / < 2²⁴ |
| zstd windowLog / XZ 字典 / XZ 内存 | 23 / 32 MiB / 128 MiB |
| 活跃 Decoder | Manifest 1 + Chunk 1 |
| 未知 Object 符号缓存 | **0** |

## 16. 跨端职责

Rust Core 唯一实现：帧/ROOT/META/Manifest/TLV 编解码、全部哈希与 ID 派生、路径校验、
OTI 验证与 RFC 分区推导、状态机、有界解压接口、单一 Receiver Snapshot ABI
（packed u64 ingest 状态字沿用，加 manifest_ready / chunk_verified 事件位）。
平台层只做：相机/捕获/QR 解码、文件系统与 IndexedDB、压缩器宿主集成、UI。
TS/Kotlin/C# 不得镜像任何线格式（消灭 v1 session.ts 双实现漂移面）。

## 17. 实现顺序与验收矩阵

顺序：① 纯 Rust AF2 模块（帧/ID/ROOT/META/Manifest + golden vectors）→ ② OTI-only RaptorQ
往返 → ③ 三 codec × 边界尺寸往返 + 资源攻击测试 → ④ Sender 调度器 + Receiver 状态机 →
⑤ 双端账本崩溃测试 → ⑥ Web 发送端 → 三接收端 → ⑦ 三端互操作后一次性切换 → ⑧ 删除全部
v1 构件 → ⑨ 位级规格合入 SPEC.md。过渡期只允许显式开发开关，正式版本单协议。

最低验收：三 codec × {空、1B、符号边界、chunk 边界、末块}；单文件/文本/空目录/多层目录/
NFC 路径；乱序/重复/突发丢帧/任意点加入；换 codec/level/T 后已完成 Chunk 复用且未完成
Decoder 不混流（关键用例：同 chunk 两种编码实例交替播放）；崩溃注入 pwrite/fsync/rename
每个间隙；Manifest 后到对暂存 Chunk 的复核清位；恶意 OTI/超长 TLV/路径穿越/解压炸弹/
大窗口/大字典；三 ABI 逐字节互操作；v1 全部构件 fail-closed 拒绝。

---

核心取舍一句话：以每帧 8B 的 Object ID 开销和 1–2% 的压缩率损失，换取自举无循环、
混流结构性不可能、块级独立提交与 O(chunk) 内存——单向信道上"确定且可证明"永远优先于
"平均更快但有洞"。
