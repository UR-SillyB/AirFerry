# API 参考 (API Reference)

## Rust 核心 API

### raptorq-core

```rust
// 配置
pub struct Config { pub symbol_size: u32 }  // 默认 1024
pub const DEFAULT_SYMBOL_SIZE: u32 = 1024;

// 编码器
pub struct Encoder { ... }
impl Encoder {
    pub fn new(data: &[u8], config: Config) -> Result<Self>;
    pub fn meta(&self) -> &ObjectMeta;
    pub fn source_symbol(&self, sbn: u32, esi: u32) -> Result<Symbol>;
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

// QR 矩阵
pub fn encode(data: &[u8]) -> Result<QrMatrix>;  // Version 40 / L

// 会话 ID
pub fn derive(name, size, mtime, fingerprint) -> SessionId;

// 压缩（native/Android only）
pub fn compress(data: &[u8], level: i32) -> Result<Vec<u8>>;
pub fn decompress(data: &[u8]) -> Result<Vec<u8>>;
```

### transfer-engine

```rust
// 发送端
pub struct SenderSession { ... }
impl SenderSession {
    pub fn new(payload: &[u8], session_id: SessionId, config: SenderConfig) -> Result<Self>;
    pub fn next_frame(&mut self) -> Result<Frame>;  // 无限循环
    pub fn stats(&self) -> Stats;
}

pub struct SenderConfig {
    pub codec: Config,
    pub redundancy_pct: u8,  // 5–50
}

// 接收端
pub struct ReceiverSession { ... }
impl ReceiverSession {
    pub fn from_first_frame(frame: &Frame) -> Self;
    pub fn ingest(&mut self, frame: Frame) -> Result<bool>;
    pub fn is_complete(&self) -> bool;
    pub fn assemble(&self) -> Option<Vec<u8>>;
    pub fn progress(&self) -> &Progress;
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
    symbolSize: number
  )
  next_frame(): Uint8Array           // 帧字节
  stats_json(): string               // {bytes, frames, fps, throughput_bps}
  total_symbols(): number
  num_blocks(): number
}

// QR 编码（独立函数）
function encode_qr(frameBytes: Uint8Array, outSide: Uint32Array): Uint8Array
// 返回扁平模块网格（1=深色, 0=浅色），outSide[0] = 边长
```

## JNI 绑定（Android）

```kotlin
object NativeBridge {
    external fun receiverCreate(
        sessionIdLo: Long, sessionIdHi: Long,
        totalBlocks: Int, totalSymbols: Int, symbolSize: Int
    ): Long  // handle

    external fun receiverIngest(
        handle: Long, frameBytes: ByteArray, outBuf: ByteArray
    ): Int  // 写入 outBuf 的字节数（进度 JSON），0 = 失败

    external fun receiverIsComplete(handle: Long): Int
    external fun receiverAssembledLength(handle: Long): Int
    external fun receiverAssemble(handle: Long, outBuf: ByteArray): Int
    external fun receiverDestroy(handle: Long)
}

object ZxingDecoder {
    external fun decodeY(
        yPlane: ByteArray, width: Int, height: Int, rowStride: Int
    ): ByteArray?  // 解码载荷或 null
}
```

### 进度 JSON 格式

`receiverIngest` 返回的 JSON：

```json
{
  "decoded_symbols": 50,
  "total_symbols": 100,
  "received_symbols": 60,
  "frames_seen": 75,
  "frames_dropped": 10,
  "frames_corrupt": 5,
  "decoded_blocks": 2,
  "total_blocks": 4,
  "decoded_fraction": 0.5,
  "loss_ratio": 0.2,
  "complete": false
}
```
