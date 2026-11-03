# API 参考 (API Reference)

## Python 发送端 API

```python
from airferry import file_to_video

result = file_to_video("data.zip", "data.mp4")
```

`file_to_video` 直接复用以下 Rust 核心，返回带视频路径、帧数和传输信息的 `VideoResult`。压缩与编码不依赖在线服务或运行期组件下载；输入、输出和临时目录使用普通文件 I/O，可为网络文件系统路径，支持 `file://` URL。完整参数、`VideoProgress` 回调及构建方式见 [Python 使用与构建指南](build-python.md) 和 [包接口说明](../apps/python/README.md)。

## Rust 核心 API

### raptorq-core

```rust
// 配置
pub struct Config { pub symbol_size: u32 }  // 默认 1024；浏览器端按速度预设传入（默认 1400）
pub const DEFAULT_SYMBOL_SIZE: u32 = 1024;

// 编码器
pub struct Encoder { ... }
impl Encoder {
    pub fn new(data: &[u8], config: Config) -> Result<Self>;
    pub fn meta(&self) -> &ObjectMeta;
    pub fn source_symbol(&self, sbn: u32, esi: u32) -> Result<Symbol>;
    // 任意合法 start 偏移 → 按需生成新鲜修复符号（ESI < 2^24）
    pub fn repair_symbols(&self, sbn: u32, start: u32, count: u32) -> Result<Vec<Symbol>>;
}

// 解码器
pub struct Decoder { ... }
impl Decoder {
    pub fn new(meta: ObjectMeta) -> Self;
    pub fn add_symbol(&mut self, symbol: &Symbol) -> Result<bool>;  // 返回是否完成
    pub fn is_complete(&self) -> bool;
    pub fn assemble(&self) -> Option<Vec<u8>>;
}

// 元数据
pub struct ObjectMeta {
    pub transfer_length: u64,
    pub symbol_size: u32,
    pub oti_bytes: [u8; 12],
    pub blocks: Vec<SourceBlockMeta>,
}
```

### qr-protocol

```rust
// 帧
pub struct Frame { pub header: FrameHeader, pub payload: Vec<u8>, pub frame_crc32: u32 }
impl Frame {
    pub fn build(session_id, flags, sbn, esi, ...) -> Self;
    pub fn to_bytes(&self) -> Vec<u8>;
    pub fn from_bytes(bytes: &[u8]) -> Result<Self>;  // 含 magic + CRC 校验
}

// QR 矩阵：按帧长选能容纳的最小 EC-L 版本（非固定 V40）
pub fn min_version_for(len: usize) -> Option<Version>;
pub fn encode(data: &[u8]) -> Result<QrMatrix>;

// 会话 ID
pub fn derive(name, size, mtime, fingerprint) -> SessionId;

// 压缩（native/Android；浏览器端在 TS 层实现）
// 算法标签：0=None, 1=Zstd, 2=XZ
pub const COMPRESSION_NONE: u8 = 0;
pub const COMPRESSION_ZSTD: u8 = 1;
pub const COMPRESSION_XZ: u8 = 2;

pub fn compress_with(data: &[u8], compression: u8) -> Result<Vec<u8>>;
pub fn decompress_with(data: &[u8], compression: u8) -> Result<Vec<u8>>;
```

### transfer-engine

```rust
// 发送端
pub struct SenderSession { ... }
impl SenderSession {
    pub fn new(
        payload: &[u8],          // 已压缩的负载
        session_id: SessionId,
        config: SenderConfig,
        file_meta: FileMeta,      // 文件名、大小、CRC32、压缩标签
    ) -> Result<Self>;
    // 源符号发完后持续产生新鲜修复符号；ESI 达上限时报错停止
    pub fn next_frame(&mut self) -> Result<Frame>;
    pub fn stats(&self) -> Stats;
}

pub struct SenderConfig {
    pub codec: Config,
    pub redundancy_pct: u8,  // 5–50；仅用于 UI 时长估算，不限制实际修复符号数
}

// 接收端
pub struct ReceiverSession { ... }
impl ReceiverSession {
    pub fn from_first_frame(frame: &Frame) -> Self;     // cache-only 引导
    pub fn ingest(&mut self, frame: Frame) -> Result<bool>;
    pub fn is_complete(&self) -> bool;
    pub fn assemble(&self) -> Option<Vec<u8>>;
    pub fn progress(&self) -> Progress;                 // 返回快照（按值）
}

// 文件元数据（携带压缩标签）
pub struct FileMeta {
    pub filename: String,
    pub original_size: u64,
    pub crc32: u32,
    pub compression: u8,           // 0=None, 1=Zstd, 2=XZ
    pub compressed_size: u64,
    pub compressed_size_known: bool,
}
```

## WASM 绑定（浏览器）

```typescript
// SenderSessionWasm（发送端）
class SenderSessionWasm {
  constructor(
    compressedPayload: Uint8Array,
    sessionIdLo: bigint,
    sessionIdHi: bigint,
    redundancyPct: number,
    symbolSize: number,
    filename: string,
    originalFileSize: bigint,
    crc32: number,
    compression: number          // 0=None, 1=Zstd, 2=XZ
  )
  next_frame(): Uint8Array        // 帧字节
  stats_json(): string           // {bytes, frames, elapsed_ms, fps, throughput_bps}
  session_id_lo(): bigint
  session_id_hi(): bigint
  total_symbols(): number
  num_blocks(): number
}

// QR 编码（独立函数）
function encode_qr(frameBytes: Uint8Array, outSide: Uint32Array): Uint8Array
// 返回扁平模块网格（1=深色, 0=浅色），outSide[0] = 边长

// ReceiverSessionWasm（接收端，网页接收端用）
class ReceiverSessionWasm {
  // 方式一（推荐）：从首个描述符帧构造。内部校验完整帧 CRC + descriptor flag，
  // 锁定 session id，摄入描述符使 meta 立即 confirmed。坏帧/非描述符/敌意
  // payload 返回 Error —— JS 侧据此丢弃首个描述符前的数据帧，并重试下一个描述符。
  static from_descriptor(frameBytes: Uint8Array): ReceiverSessionWasm

  // 方式二：缓存引导（与 JNI receiverCreate / C ABI airferry_receiver_create 一致）。
  // data frames 缓存直到首个校验过的描述符到来。sid_lo/hi 为 128 位 session id 的低/高 64 位。
  constructor(sessionIdLo: bigint, sessionIdHi: bigint)

  // 摄入一帧解码后的 QR 原始字节（header+payload+footer）。返回 packed u64：
  //   bit0 complete | bit1 accepted | bits8..23 session_mismatch_streak | bits32..63 received_symbols
  // 位布局与 JNI receiverIngest / C ABI airferry_receiver_ingest 完全一致（三端共享 ingest_status::pack）。
  // received_symbols == 0xFFFFFFFF（INGEST_ERROR）= 帧被拒（CRC/长度校验失败）。
  ingest(frameBytes: Uint8Array): bigint

  progress_json(): string   // 同 JNI receiverProgressJson 的 JSON 字段
  is_complete(): boolean

  // 元数据（对齐 JNI receiverFileName/FileSize/Crc32/Crc32Known）
  session_id_lo(): bigint
  session_id_hi(): bigint
  file_name(): string       // 空字符串直到描述符到来
  original_size(): bigint   // 解压后原文件大小
  compressed_size(): bigint // 传输载荷大小
  compressed_size_known(): boolean
  compression(): number     // 0=None,1=Zstd,2=Xz —— JS 侧据此选解压器
  crc32(): number           // 注意 JS 侧用 >>> 0 读无符号（0xDEADBEEF 超有符号 32 位）
  crc32_known(): boolean
  meta_confirmed(): boolean

  // 只重组不解压。返回传输字节（compressed_size_known 时截断到 compressed_size）。
  // compression==NONE 时即原文件；Zstd/Xz 时 JS 侧用 @foxglove/wasm-zstd / lzma-wasm 解压
  // 后校验长度==original_size、CRC32（crc32_known 时）。未完成返回空 Uint8Array。
  assemble_raw(): Uint8Array
}
```

> **WASM 接收端不内置解压**：wasm32 构建下 `qr-protocol` 的 zstd/xz C 库无法编译，
> `decompress_with_limit` 对 `COMPRESSION_ZSTD`/`COMPRESSION_XZ` **fail-closed**（返回 Err），
> 仅 `COMPRESSION_NONE` 原样返回。因此网页接收端走 `assemble_raw` + JS 侧自解压，
> 不调用会触发解压的 `assemble_result`。发送端压缩仍在 worker 内用 JS 侧 zstd/xz 完成，两端 on-wire 格式一致。

> **构造参数来源**：`compressedPayload` / `sessionId` / `crc32` / `compression` 由 `src/workers/compress.worker.ts` 离线产出（避免同步 WASM 卡住 UI）。主线程仅在用户点「发送」后 postMessage（均带 `jobId` = 当前 epoch）：
> - `{ jobId, text, name? }` → `processText`：包 `ETTEXTv1` 魔数后压缩（**仅**列表里恰好 1 条文字时）；`name` 经 `normalizeDraftFilename` 写入 descriptor 并参与 session 派生（缺省 `文字消息.txt`）
> - `{ jobId, files }` → `processFiles`：0/1 文件原样；≥2 → `bundle.ts` ETBUNDL1；混发时文字已物化为命名 `.txt` File
> - `{ type: "wasm-init", zstd?: ArrayBuffer \| null }`：主线程**始终**发送（失败时 `zstd: null`），worker 标记 ready；无 zstd 时 `preparePayload` 回退 raw，**不得**永久挂起队列
> - 过期 `jobId` 的 progress/`done`/`error` 在 worker 与主线程双侧丢弃（改列表/回选择页 bump epoch）
> 然后 `compress.ts` 三算法选优 → CRC → `session.ts` 派生会话 ID。详见 [protocol.md](protocol.md)、[data-flow.md](data-flow.md)。

## JNI 绑定（Android）

```kotlin
object NativeBridge {
    external fun receiverCreate(
        sessionIdLo: Long, sessionIdHi: Long,
        totalBlocks: Int, totalSymbols: Int, symbolSize: Int
    ): Long  // handle（不透明指针）

    // 摄入一帧；返回 packed Long：完成/接受/mismatch/已收符号数，位布局见 SPEC.md
    external fun receiverIngest(handle: Long, frameBytes: ByteArray): Long

    // UI 约 7Hz 拉取完整进度；NUL 结尾 JSON，native 失败可返回 null/空数组
    external fun receiverProgressJson(handle: Long): ByteArray?

    external fun receiverIsComplete(handle: Long): Int
    external fun receiverAssembleBytes(handle: Long): ByteArray?
    external fun receiverLastAssembleError(handle: Long): String
    external fun receiverDestroy(handle: Long)

    // 文件元数据（来自描述符帧）
    external fun receiverFileName(handle: Long): String
    external fun receiverFileSize(handle: Long): Long
    external fun receiverCrc32(handle: Long): Long   // 无符号 32 位装入 Long
    external fun receiverCrc32Known(handle: Long): Int
}

object ZxingDecoder {
    external fun decodeY(
        yPlane: ByteArray, width: Int, height: Int, rowStride: Int
    ): ByteArray?  // 解码载荷或 null；native 按 rowStride 读取完整 Y 平面
}
```

> **线程模型**：`receiverIngest`/`receiverAssembleBytes` 等操作同一原生句柄，**非线程安全**。Android 侧用一把 ingest 锁串行化所有调用，ZXing 解码则在多个 worker 上并行（见 [data-flow.md](data-flow.md)）。

### 进度 JSON 格式

`receiverProgressJson` 返回的 JSON（`receiverIngest` 只返回 packed `Long`）：

```json
{
  "decoded_symbols": 50,
  "total_symbols": 100,
  "received_symbols": 60,
  "frames_seen": 75,
  "frames_duplicate": 10,
  "frames_corrupt": 5,
  "decoded_blocks": 2,
  "total_blocks": 4,
  "decoded_fraction": 0.5,
  "loss_ratio": 0.2,
  "complete": false,
  "meta_confirmed": true,
  "session_mismatch_streak": 0
}
```
