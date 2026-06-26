# 跨端契约规格 (Cross-Platform Contract SPEC)

> **本文是「三端都必须遵守」的不变量清单**——Rust 核心（`core/`）、浏览器发送端（`apps/sender/`）、Android 接收端（`apps/scanner/`）之间所有线格式与接口的**位级权威定义**。
>
> - 与 `protocol.md` / `api.md` 互补：那两份讲「为什么」和「用法」，本文讲「字节怎么排、位怎么编码」，且**聚焦于容易漂移的细节**。
> - **冲突时以代码为准**：每个字段都标注了权威源文件位置。
> - 改协议字段时，三端必须同步，并同步更新本文。

---

## 1. 会话 ID 派生（断点恢复的基石）

同一文件重发必须产生**相同** session_id，接收端据此识别并断点恢复。

### 输入与哈希

```
session_id = FNV1a_128( name_utf8 || size_le64 || mtime_ms_le64 || fingerprint )
fingerprint = FNV1a_64( head_1KiB || tail_1KiB )   → 输出 8 字节（小端）
```

- 喂入顺序固定：**文件名(UTF-8) → size(LE u64) → mtime 毫秒(LE u64) → 指纹字节**。
- FNV-1a 128 常量：offset basis `0x6c62272e07bb01426b82175983ad0b58`，prime `0x0000000001000000000000000000013b`。
- FNV-1a 64 常量：offset basis `0xcbf29ce484222325`，prime `0x100000001b3`。
- 指纹覆盖**头 1 KiB + 尾 1 KiB**（小文件取实际长度），检测截断/追加而无需全量哈希。

### 双端实现（必须位一致）

| 端 | 源 |
|----|-----|
| Rust | `core/qr-protocol/src/session.rs:23` `SessionId::derive` + `:52` `content_fingerprint` |
| 浏览器 (TS) | `apps/sender/src/wasm/session.ts:17` `deriveSessionId` + `:39` `contentFingerprint` |

> ⚠️ 改其中任一端的哈希实现或输入顺序，另一端必须同步，否则断点恢复失效。

---

## 2. 线帧格式（Wire Frame）

每帧 = `[Header 60B][Payload T B][Footer 4B]`，**T = symbol_size**。所有多字节整数**大端序**。

- 一次会话内 T 恒定。浏览器默认 **1400**（`apps/sender/src/types.ts` `DEFAULT_CONFIG.symbolSize`，激进预设；整帧 1464B → QR V27 125×125）；核心库默认 **1024**（`core/raptorq-core/src/config.rs:8` `DEFAULT_SYMBOL_SIZE`，整帧 1088B → QR V23 109×109）。接收端从帧头 `symbol_size` 自适应。
- magic `0x4554`（ASCII "ET"），version `1`。

### Header（60 字节）

| 偏移 | 长度 | 字段 | 类型 | 说明 |
|------|------|------|------|------|
| 0 | 2 | magic | u16 BE | `0x4554` |
| 2 | 1 | version | u8 | `1` |
| 3 | 1 | flags | u8 | bit0 = `FLAG_DESCRIPTOR` (`0x01`) |
| 4 | 16 | session_id | u128 BE | 会话 ID |
| 20 | 4 | sbn | u32 BE | RaptorQ 源块号 |
| 24 | 4 | esi | u32 BE | 编码符号 ID（源 < K，修复 ≥ K） |
| 28 | 4 | total_blocks | u32 BE | 源块总数 |
| 32 | 4 | total_symbols | u32 BE | 源符号总数 K |
| 36 | 4 | symbol_size | u32 BE | T |
| 40 | 8 | frame_index | u64 BE | 单调帧号（统计） |
| 48 | 8 | timestamp_ms | u64 BE | 发送端 UNIX 毫秒 |
| 56 | 4 | payload_crc32 | u32 BE | 载荷 CRC32 |

### Footer（4 字节）

| 偏移 | 长度 | 字段 | 说明 |
|------|------|------|------|
| 60+T | 4 | frame_crc32 | 覆盖 Header+Payload 的整帧 CRC32 |

### 双层 CRC

`payload_crc32`（Header 内）+ `frame_crc32`（Footer）任一失败 → 丢弃该帧，靠 RaptorQ 冗余恢复。CRC 仅保完整性、**不认证**。

### 权威源

| 端 | 源 |
|----|-----|
| Rust 构/析 | `core/qr-protocol/src/frame.rs:71` `build` / `:109` `to_bytes` / `:122` `from_bytes` |
| 常量 | `frame.rs:13-22`：`MAGIC=0x4554`、`PROTOCOL_VERSION=1`、`FLAG_DESCRIPTOR=0x01`、头 60 / 尾 4 |
| Kotlin 帧头解析 | `apps/scanner/.../scan/ReceiverSessionManager.kt:98` `parseHeader`（镜像上述布局） |

---

## 3. 描述符帧载荷（Descriptor Payload）

描述符帧（`flags & 0x01`）的 payload 不是符号，而是**权威对象元数据**（OTI + 每块 K + 文件元数据 + 压缩标签），零填充到 T 字节。首帧即描述符；之后每 16 帧插一个。

### 布局（大端，载荷内偏移）

| 偏移 | 长度 | 字段 | 说明 |
|------|------|------|------|
| 0 | 1 | magic | `0xD5` |
| 1 | 1 | version | `3`（当前；2/1 为旧版） |
| 2 | 2 | num_blocks | u16 BE |
| 4 | 8 | transfer_length | u64 BE（RaptorQ 对象字节数，含填充） |
| 12 | 4 | symbol_size | u32 BE |
| 16 | 12 | oti_bytes | RFC 6330 OTI 线格式 |
| 28 | 16×B | blocks[] | 每块：`sbn(u32) + num_source_symbols(u32) + block_length(u64)` |

记块表末尾 `P = 28 + 16×B`。

**v2 扩展**（紧跟块表）：

| 偏移 | 长度 | 字段 |
|------|------|------|
| P | 1 | filename_len（0..=255） |
| P+1 | filename_len | filename（UTF-8） |
| P+1+fn | 8 | original_size（u64 BE，压缩前原始字节） |
| P+9+fn | 4 | crc32（u32 BE，原始文件 CRC32） |

记 v2 末尾 `Q = P + 1 + filename_len + 12`。

**v3 扩展**（紧跟 v2）：

| 偏移 | 长度 | 字段 |
|------|------|------|
| Q | 1 | compression（u8：0=None, 1=Zstd, 2=XZ） |
| Q+1 | 8 | compressed_size（u64 BE，压缩后负载字节，RaptorQ 填充前） |

剩余零填充。固定开销 28 + 每块 16 + v2 尾 13 + filename_len + v3 尾 9，默认 1024 symbol 下数百块内轻松装入。

### v2/v3 消歧规则（关键，易踩坑）

载荷总是补零到 T 字节，因此仅凭「剩余 ≥ 9 字节」**无法区分** v3 尾部与 v2 补零——全零 9 字节会被误读为 `compressed_size=0`，导致恢复结果被截成空文件。解析器**仅当 `version ≥ 3` 或尾部非全零**时才当 v3；否则按 v2（`compression=None`、`compressed_size == original_size`）。

### 运行时标志（不在线上）

`FileMeta` 有两个**仅运行时**的布尔标志（不序列化），避免用 `0` 当哨兵误伤合法的零值：
- `compressed_size_known`：区分「真的 0 字节」与「描述符未提供」。
- `crc32_known`：区分「真的 CRC=0」与「未验证」（v1/`default()` 置 false，跳过校验而非对比无意义的 0）。

### 权威源

| 端 | 源 |
|----|-----|
| Rust 构/析 | `core/transfer-engine/src/descriptor.rs:106` `build_payload` / `:178` `parse_payload` |
| 常量 | `descriptor.rs:95-102`：`DESC_MAGIC=0xD5`、`DESC_VERSION=3`、固定开销 28/13/9 |

---

## 3.5 载荷内容类型（Payload Content Kind）

> **关键设计**：descriptor **不含** mime/kind 字段。文字 / 单文件 / 多文件包的区分**全部在载荷字节层**用魔数前缀完成——与 descriptor 协议解耦，向后兼容老接收端。三种类型复用同一套 RaptorQ + 压缩 + 帧管线，仅「字节如何产生」与「恢复后如何解释」不同。

接收端恢复 + 解压后的字节，按**如下优先级**逐个检测魔数（先到先匹配，互不重叠）：

| 顺序 | 魔数（前 8 字节 ASCII） | 类型 | 载荷布局（魔数之后） |
|------|----------------------|------|---------------------|
| ① | `ETTEXTv1`（`0x45 54 54 45 58 54 76 31`） | **文字** | UTF-8 文本，无长度前缀（由 `original_size`/`compressed_size` 定界） |
| ② | `ETBUNDL1`（`0x45 54 42 55 4E 44 4C 31`） | 多文件包 | u16 version + u16 count + 逐项 `{name, size, content}`（见 §3.6） |
| ③ | （无匹配） | 单文件 | 原始文件字节 |

### 文字载荷（ETTEXTv1）

```
offset  size   field
0       8      magic: ASCII "ETTEXTv1"
8       …      UTF-8 文本字节（message body）
```

- **无 per-field CRC**：整段文字受 transfer-level CRC32（descriptor）+ RaptorQ + 双层帧 CRC 保护，与单文件完全一致。
- **descriptor 字段**：`filename = "文字消息.txt"`、`original_size = 8 + len(utf8)`、其余字段照常。老接收端不认 ETTEXTv1 → 落到单文件兜底（③），存成 `.txt` 仍可正常打开（向后兼容）。
- **会话 ID 派生**：name=`"文字消息.txt"`、size=`8+len`、mtime=`Date.now()`（发送时刻，替代文件的 `lastModified`）、fingerprint=内容指纹（头/尾 1024B）。

### 权威源

| 端 | 源 |
|----|-----|
| 浏览器发送端 | `apps/sender/src/wasm/text.ts`：`TEXT_MAGIC`/`buildTextPayload`/`isTextPayload` |
| Android 接收端 | `apps/scanner/.../scan/TextParser.kt`：`isText`/`parse` |
| Windows 接收端 | `apps/windows/AirFerry.Windows/Bundle/TextParser.cs`：`IsText`/`Parse`（跨平台单测 `TextParserTests.cs`） |
| 分流入口 | Android `ScanActivity.recoverAndStage`（text→bundle→单文件）/ Windows `ScanViewModel.RecoverAndStage`（同序） |

### 3.6 多文件包载荷（ETBUNDL1）

多文件打包格式（大端）：

```
offset  size   field
0       8      magic: ASCII "ETBUNDL1"
8       2      version: u16 = 1
10      2      file_count: u16
12      …      file_count × { u16 name_len, name_len name UTF-8, u64 size, size content }
```

> 发送端仅在选中 ≥2 个文件时打包；单文件直传原始字节（无魔数）。权威源：`apps/sender/src/wasm/bundle.ts`（TS）/ `apps/scanner/.../scan/BundleParser.kt`（Android）/ `apps/windows/AirFerry.Windows/Bundle/BundleParser.cs`（Windows），三端字节级一致。

---

## 4. 压缩（三算法选优）

### 算法标签

| 标签 | 算法 | 说明 |
|------|------|------|
| `0` | None (Raw) | 原始字节直传 |
| `1` | Zstd | 浏览器 level **1**（快速；媒体类二进制负载损失可忽略） |
| `2` | XZ / LZMA2 | 浏览器 level **9**；native `xz2` preset 6 + EXTREME；解压端兼容 |

> ⚠️ **以代码为准**：`apps/sender/src/wasm/compress.ts:55-64`。旧文档写「Zstd Lv22 / 95% early-exit」**已过时**（`e10079d`/`c2ae4a2` 已调为 Zstd level 1、阈值 70%）。

### 浏览器选优策略（`compress.ts:277 preparePayload`）

1. **Raw**：始终候选。
2. **Zstd (Lv1)**：始终运行。
3. **XZ (Lv9)**：仅当 Zstd 压缩率 **< 70%** 时运行（`ZSTD_ALREADY_COMPRESSED_RATIO = 0.70`，跳过已压缩文件如 JPEG/MP4 的慢速 XZ）。

最终取所有已运行候选中**最小**者，标签写入描述符 v3 扩展。

### 解压（接收端）

按描述符 `compression` 标签解压。**炸弹防护**：`core/qr-protocol/src/compress.rs:97 decompress_with_limit` 把输出上限封顶到描述符 `original_size`，超限即判失败，防 OOM。

### 权威源

| 端 | 源 |
|----|-----|
| Rust 分发 | `core/qr-protocol/src/compress.rs:68` `compress_with` / `decompress_with` / `:97` `decompress_with_limit` |
| 标签常量 | `compress.rs:28-30`：`COMPRESSION_NONE=0`/`ZSTD=1`/`XZ=2` |
| 浏览器 (TS) | `apps/sender/src/wasm/compress.ts:49` `CompressionAlgorithm` 枚举（镜像） |

---

## 5. RaptorQ 符号坐标

| 符号类型 | ESI 范围 | 说明 |
|---------|---------|------|
| 源符号 | `[0, K_block)` | 原始数据符号 |
| 修复符号 | `[K_block, ∞)` | 喷泉码生成，无限可生成 |

- **SBN**：u8（0–255），源块号。
- **ESI**：u24（0–16777215）。
- **越界拒绝**：接收端拒绝 `ESI ≥ 2²⁴` 或载荷长度 ≠ `symbol_size` 的数据帧——否则触发底层 `raptorq` crate panic（`panic="abort"` 下致命）。守卫在 `core/raptorq-core/src/decoder.rs:78` + `core/transfer-engine/src/receiver.rs:208-222`。
- **块上限**：`MAX_SOURCE_SYMBOLS_PER_BLOCK = 56403`，`MAX_SOURCE_BLOCKS = 256`（`core/raptorq-core/src/meta.rs:6,8`）。

### 发射策略（发送端，消除 coupon-collector 拖尾）

1. **源符号阶段（仅一遍）**：所有源符号跨块轮询（esi-major）输出——先每块 esi=0，再每块 esi=1……突发丢帧被均摊到所有块。
2. **无限新鲜修复阶段**：源符号发完后持续生成修复符号，跨块轮询，每块修复 ESI **单调递增、永不重复**（block_b 第 m 轮 ESI = K_b + m）。

→ 源符号发完后**每一帧都是接收端从未见过的新符号**，进度近似线性。`redundancy_pct`（5–50，默认 25）**仅用于 UI 时长估算**，不限制实际修复符号数。

### 权威源

`core/raptorq-core/src/encoder.rs:63,73`（源/修复符号）、`core/transfer-engine/src/sender.rs:164` `next_frame` / `:235` `next_symbol_id`。

---

## 6. 安全边界（panic=abort 下的生命线）

本 workspace 以 `panic = "abort"` 构建（`Cargo.toml`）——**任何 panic = 进程崩溃**。因此必须把恶意/越界输入挡在解码器之前：

| 防线 | 位置 | 作用 |
|------|------|------|
| OTI 校验 | `core/raptorq-core/src/meta.rs:97` `ObjectMeta::validate` | 接收前校验 symbol_size、OTI 一致性、块数、K 范围、`block_length == K*symbol_size`；非法则按损坏帧丢弃，绝不构建非法解码器 |
| 坐标守卫 | `decoder.rs:78` + `receiver.rs:208-222` | 拒绝 ESI≥2²⁴ / 载荷≠symbol_size |
| 解压炸弹 | `compress.rs:97 decompress_with_limit` | 输出封顶到 `original_size` |
| 帧校验 | `frame.rs:122 from_bytes` | magic/version/双层 CRC |

> 接收端扫描的是**任意屏幕**的二维码，描述符/帧元数据均**不可信**。CRC32 仅保完整性、不认证——上述参数校验才是真正防线。

---

## 7. JNI ingest 状态字位布局（权威）

⚠️ Android JNI 的 `receiverIngest` **不返回 JSON**（旧 `docs/api.md` 已过时）。返回一个 packed `jlong`，只携带摄入路径决策所需的最小信息；完整进度按需由 `receiverProgressJson`（~7Hz UI 节流）拉取。

### 位布局（`jlong`，所有字段无符号）

| 位 | 字段 | 说明 |
|----|------|------|
| bit 0 | `complete` | 1 = 对象已完全解码 |
| bit 1 | `accepted` | 1 = 本帧贡献了新符号 |
| bits 8..23 | `session_mismatch_streak` | 连续 session 不匹配数（0..=0xFFFF） |
| bits 32..63 | `received_symbols` | 已接收去重符号数（低 32 位） |

### 哨兵

- 返回 **`0`**：null handle / 坏帧 / session 错误（调用方视作「无变化」）。
- `received_symbols == u32::MAX`（`0xFFFFFFFF`）：**保留错误哨兵**（真实传输永不达到）。Kotlin `IngestStatus.unpack` 遇此返回 `null`。

### 双端对齐

| 端 | 源 |
|----|-----|
| Rust 打包 | `core/transfer-engine/src/jni.rs:68` `receiverIngest` / `:130` `pack_ingest_status` |
| Kotlin 解包 | `apps/scanner/.../scan/ReceiverSessionManager.kt:67` `IngestStatus.unpack` |

> 改位布局时两端必须同步。

### 其他 JNI 函数（修正）

| 函数 | 签名 | 说明 |
|------|------|------|
| `receiverCreate` | `(sidLo, sidHi, _blocks, _symbols, _symSize) -> Long` | 缓存引导，**不**从 caller 提供的 totals 建解码器（等待首个校验过的描述符帧） |
| `receiverIngest` | `(handle, frameBytes) -> Long` | 见上 |
| `receiverProgressJson` | `(handle) -> String` | 按需 JSON（UI ~7Hz） |
| `receiverIsComplete` | `(handle) -> Int` | 0/1 |
| `receiverAssembleBytes` | `(handle) -> ByteArray` | **原子返回完整字节**（修复了旧 `receiverAssemble(handle,outBuf)` 的 >2GB 截断 + 长度/填充竞态） |
| `receiverDestroy` | `(handle)` | 释放 |
| `receiverFileName/FileSize/Crc32/Crc32Known` | `(handle) -> ...` | 文件元数据访问器 |

> **线程模型**：上述所有操作同一原生句柄，**非线程安全**。Android 用一把 `ingestLock` 串行化；ZXing 解码在 N 个 worker 上并行。

---

## 8. QR 编码

| 参数 | 值 |
|------|-----|
| 纠错级别 | **L**（最低冗余，最大化容量） |
| 版本 | **动态最小**（`qr_render::min_version_for`），非固定 V40 |
| 模式 | Binary |

| symbol_size | 整帧字节 | 版本 | 模块数 |
|-------------|---------|------|--------|
| 512（浏览器 `stable` 预设） | 576 | V16 | 81×81 |
| 1024（核心库默认） | 1088 | V23 | 109×109 |
| 1400（浏览器默认，`aggressive` 预设） | 1464 | V27 | 125×125 |

> 历史教训：曾强制 V40（177×177），模块过密致数据帧无法解码、收端卡 0%。改最小版本后稳定。

### 16 KiB 页对齐（Android 15+）

16 KiB 页设备内核拒绝 `dlopen` 仅 4 KiB（`0x1000`）对齐 LOAD 段的 `.so`——表现：`System.loadLibrary` 抛 `UnsatisfiedLinkError`，**所有 QR 解码静默失败**。
- ZXing `.so`：`apps/scanner/app/src/main/cpp/CMakeLists.txt` 用 `-Wl,-z,max-page-size=16384` 强制对齐。
- Rust `.so`：cargo-ndk/LLVM 默认对齐。
- 验证：`llvm-readelf -l lib*.so | grep LOAD`，Align 列应为 `0x4000`。

### 权威源

| 端 | 源 |
|----|-----|
| Rust 编码 | `core/qr-protocol/src/qr_render.rs:74` `encode` / `:41` `min_version_for` |
| WASM（帧→矩阵一次调用） | `core/transfer-engine/src/wasm.rs:86` `next_qr` / `:113` `next_qr_multi` |
| 浏览器渲染 | `apps/sender/src/components/QrStream.tsx:37`（rAF 循环）/ `:239` `drawMatrix` |

---

## 9. 版本号（单一来源）

三处版本必须保持一致，改版本时一起改：

| 源 | 当前 |
|----|------|
| `Cargo.toml` `[workspace.package] version` | `1.0.0` |
| `apps/sender/package.json` `version` + `manifest.version` | `1.0.0` |
| `apps/scanner/app/build.gradle.kts` `versionName` / `versionCode` | `1.0.0` / `1` |

`scripts/build-all.sh` 的 release 打包文件名版本号由 `read_version()`（`build-all.sh:40`）从 `apps/sender/package.json` 动态读取，与 `manifest.version` 同源，**无需在脚本里手改**。

---

## 速查：常量表

| 常量 | 值 | 位置 |
|------|-----|------|
| 帧 magic | `0x4554` | `frame.rs:13` |
| 帧版本 | `1` | `frame.rs:14` |
| 帧头/尾 | 60 / 4 字节 | `frame.rs:16,17` |
| `FLAG_DESCRIPTOR` | `0x01` | `frame.rs:22` |
| 描述符 magic | `0xD5` | `descriptor.rs:95` |
| 描述符版本 | `3` | `descriptor.rs:96` |
| 描述符固定开销 | 28 + 16×B（块表）+ 13（v2）+ filename_len + 9（v3） | `descriptor.rs:97-102` |
| 压缩 None/Zstd/XZ | `0` / `1` / `2` | `compress.rs:28-30` |
| Zstd level（浏览器） | `1` | `compress.ts:56` |
| XZ level（浏览器） | `9` | `compress.ts:58` |
| early-exit 阈值 | `0.70`（70%） | `compress.ts:64` |
| MAX_SOURCE_SYMBOLS_PER_BLOCK | `56403` | `meta.rs:6` |
| MAX_SOURCE_BLOCKS | `256` | `meta.rs:8` |
| ESI 上限 | `2²⁴`（u24） | `decoder.rs:78` |
| ingest 错误哨兵 | `received_symbols == u32::MAX` | `jni.rs:130` / `ReceiverSessionManager.kt:64` |
| 默认 symbol_size（浏览器/核心库） | 1400 / 1024 | `apps/sender/src/types.ts` `DEFAULT_CONFIG.symbolSize` / `config.rs:8` `DEFAULT_SYMBOL_SIZE` |
| QR EC 级 / 版本 | L / 动态最小 | `qr_render.rs:26,74` |
