# API 参考 (API Reference)

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
    // 任意 start 偏移 → 支持无限生成新鲜修复符号
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
    // 源符号发完后无限产生新鲜修复符号；每 16 帧插描述符（首帧即描述符）
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
```

> **构造参数来源**：`compressedPayload` / `sessionId` / `crc32` / `compression` 并非主线程直接计算，而是由 `src/workers/compress.worker.ts` 在 Web Worker 里离线产出（避免同步 WASM 压缩卡住 UI）：读文件 →（≥2 文件）`bundle.ts` 打包成 ETBUNDL1 → `compress.ts` 三算法选优 → `crc32.ts` 算 CRC → `session.ts` 派生会话 ID（FNV-1a 128；打包时身份基于整个 bundle）。单文件不打包，保持向后兼容。多文件打包格式见 [protocol.md](protocol.md#多文件打包-bundle)。

## JNI 绑定（Android）

```kotlin
object NativeBridge {
    external fun receiverCreate(
        sessionIdLo: Long, sessionIdHi: Long,
        totalBlocks: Int, totalSymbols: Int, symbolSize: Int
    ): Long  // handle（不透明指针）

    // 摄入一帧；返回新分配的 byte[]（进度 JSON，NUL 结尾），出错返回 null/空数组
    external fun receiverIngest(handle: Long, frameBytes: ByteArray): ByteArray?

    external fun receiverIsComplete(handle: Long): Int
    external fun receiverAssembledLength(handle: Long): Int
    external fun receiverAssemble(handle: Long, outBuf: ByteArray): Int
    external fun receiverDestroy(handle: Long)

    // 文件元数据（来自描述符帧）
    external fun receiverFileName(handle: Long): String
    external fun receiverFileSize(handle: Long): Long
    external fun receiverCrc32(handle: Long): Long   // 无符号 32 位装入 Long
}

object ZxingDecoder {
    external fun decodeY(
        yPlane: ByteArray, width: Int, height: Int, rowStride: Int
    ): ByteArray?  // 解码载荷或 null（接收端对中心 ROI 裁剪后调用）
}
```

> **线程模型**：`receiverIngest`/`receiverAssemble` 等操作同一原生句柄，**非线程安全**。Android 侧用一把 ingest 锁串行化所有调用，ZXing 解码则在多个 worker 上并行（见 [data-flow.md](data-flow.md)）。

### 进度 JSON 格式

`receiverIngest` 返回的 JSON（键与 `jni.rs::progress_json` 一致）：

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
