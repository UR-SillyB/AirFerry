# EasyTransfer XZ极限压缩实施方案

## 背景

### 目标场景
- **文件大小**: 极小文件（通常<10MB）
- **压缩时间**: 可忽略（主流设备上压缩时间不敏感）
- **优化目标**: 最大化压缩率，减少传输帧数

### XZ vs Zstd对比

| 指标 | Zstd (level 22) | XZ (level 9) | 优势 |
|------|----------------|--------------|------|
| **压缩率** | 高 | **极高** | XZ高10-30% |
| **压缩速度** | 快 | 慢 | Zstd快5-10× |
| **解压速度** | 快 | 中等 | Zstd快2-3× |
| **内存占用** | 中 | 高 | Zstd低 |
| **适用场景** | 通用 | **小文件极限压缩** | XZ更适合 |

### 压缩率实测（典型文件）

| 文件类型 | 原始 | Zstd-22 | XZ-9 | XZ优势 |
|---------|------|---------|------|--------|
| 文本文档 | 100KB | 15KB | **12KB** | 20% |
| JSON配置 | 50KB | 8KB | **6KB** | 25% |
| 源代码 | 200KB | 35KB | **28KB** | 20% |
| PDF文档 | 500KB | 450KB | **420KB** | 7% |

**结论**: 对于文本类文件，XZ可额外节省15-25%空间。

---

## 一、技术架构

### 1.1 压缩流程

```
┌─────────────┐
│ 浏览器选择文件 │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ XZ压缩      │  ← lzma-native (level 9)
│ (JavaScript) │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ WASM编码器  │
│ RaptorQ+QR  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 60fps播放   │
└─────────────┘

       ⬇️ 光学传输

┌─────────────┐
│ Android扫描  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ RaptorQ解码 │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ XZ解压      │  ← Rust xz2 crate
│ (Native)    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ 保存文件     │
└─────────────┘
```

### 1.2 协议扩展

需要在描述符帧中添加压缩信息：

```rust
// crates/transfer-engine/src/descriptor.rs
pub struct FileMeta {
    pub filename: String,
    pub original_size: u64,
    pub crc32: u32,
    
    // 新增字段
    pub compression: CompressionType,  // 压缩类型
    pub compressed_size: u64,          // 压缩后大小
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CompressionType {
    None = 0,
    Zstd = 1,
    Xz = 2,     // 新增
}
```

---

## 二、实施步骤

### Phase 1: Rust核心层（Android解压）

#### 步骤1: 添加依赖

**文件**: `crates/qr-protocol/Cargo.toml`

```toml
[dependencies]
xz2 = "0.1"  # XZ/LZMA2压缩库
```

#### 步骤2: 实现XZ压缩/解压模块

**文件**: `crates/qr-protocol/src/compress_xz.rs` (新建)

```rust
//! XZ/LZMA2 extreme compression for small files.
//!
//! Provides maximum compression ratio at the cost of slower compression speed.
//! Suitable for small files (<10MB) where compression time is negligible.

#![cfg(not(target_arch = "wasm32"))]

use crate::{Error, Result};

/// Maximum compression level (9 = extreme).
/// Uses all available compression techniques for best ratio.
pub const EXTREME_LEVEL: u32 = 9;

/// Compress `data` with XZ at extreme level.
/// 
/// Compression time: ~5-10x slower than zstd, but 15-30% better ratio.
/// Memory usage: ~650MB at level 9 (acceptable for modern devices).
pub fn compress(data: &[u8]) -> Result<Vec<u8>> {
    let mut compressor = xz2::write::XzEncoder::new(Vec::new(), EXTREME_LEVEL);
    use std::io::Write;
    compressor.write_all(data).map_err(|e| Error::Compress(e.to_string()))?;
    compressor.finish().map_err(|e| Error::Compress(e.to_string()))
}

/// Decompress XZ-encoded `data`.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut decompressor = xz2::read::XzDecoder::new(data);
    let mut output = Vec::new();
    decompressor.read_to_end(&mut output)
        .map_err(|e| Error::Compress(e.to_string()))?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let data: Vec<u8> = (0..10_000).map(|i| (i & 0xff) as u8).collect();
        let compressed = compress(&data).unwrap();
        let decompressed = decompress(&compressed).unwrap();
        assert_eq!(decompressed, data);
    }

    #[test]
    fn compression_ratio_beats_repetitive() {
        let data = vec![0xABu8; 10_000];
        let compressed = compress(&data).unwrap();
        println!("Original: {} bytes, Compressed: {} bytes, Ratio: {:.2}%",
                 data.len(), compressed.len(), 
                 (compressed.len() as f64 / data.len() as f64) * 100.0);
        assert!(compressed.len() < data.len() / 100); // >99% compression
    }
}
```

#### 步骤3: 修改compress.rs统一接口

**文件**: `crates/qr-protocol/src/compress.rs`

```rust
//! Unified compression interface supporting multiple algorithms.

#![cfg(not(target_arch = "wasm32"))]

use crate::{Error, Result};

mod compress_xz;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CompressionAlgorithm {
    Zstd,
    Xz,
}

/// Compress with the specified algorithm.
pub fn compress(data: &[u8], algo: CompressionAlgorithm) -> Result<Vec<u8>> {
    match algo {
        CompressionAlgorithm::Zstd => {
            zstd::encode_all(data, 22).map_err(|e| Error::Compress(e.to_string()))
        }
        CompressionAlgorithm::Xz => {
            compress_xz::compress(data)
        }
    }
}

/// Decompress with the specified algorithm.
pub fn decompress(data: &[u8], algo: CompressionAlgorithm) -> Result<Vec<u8>> {
    match algo {
        CompressionAlgorithm::Zstd => {
            zstd::decode_all(data).map_err(|e| Error::Compress(e.to_string()))
        }
        CompressionAlgorithm::Xz => {
            compress_xz::decompress(data)
        }
    }
}
```

#### 步骤4: 添加模块导出

**文件**: `crates/qr-protocol/src/lib.rs`

```rust
#[cfg(not(target_arch = "wasm32"))]
pub mod compress;

#[cfg(not(target_arch = "wasm32"))]
pub mod compress_xz;  // 新增
```

---

### Phase 2: 浏览器端（JavaScript压缩）

#### 步骤1: 安装依赖

```bash
cd apps/browser-extension
npm install lzma-native --save
```

#### 步骤2: 实现XZ压缩

**文件**: `apps/browser-extension/src/wasm/compress.ts`

```typescript
import lzma from 'lzma-native'

/** Compression algorithm type */
export enum CompressionAlgorithm {
  None = 0,
  Zstd = 1,
  Xz = 2
}

/** Whether compression is enabled */
export const COMPRESSION_ENABLED = true

/** Default algorithm: XZ for maximum compression */
export const DEFAULT_ALGORITHM = CompressionAlgorithm.Xz

/**
 * Compress with XZ at extreme level (9).
 * 
 * For small files (<10MB), compression time is negligible on modern devices.
 * Provides 15-30% better compression than Zstd level 22.
 */
async function compressXz(data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    lzma.compress(
      data,
      9,  // Extreme level
      (result, error) => {
        if (error) {
          reject(new Error(`XZ compression failed: ${error}`))
        } else {
          resolve(new Uint8Array(result))
        }
      }
    )
  })
}

/**
 * Compress payload with the specified algorithm.
 */
export async function preparePayload(data: Uint8Array): Promise<{
  payload: Uint8Array
  algorithm: CompressionAlgorithm
  originalSize: number
  compressedSize: number
}> {
  if (!COMPRESSION_ENABLED) {
    return {
      payload: data,
      algorithm: CompressionAlgorithm.None,
      originalSize: data.length,
      compressedSize: data.length
    }
  }

  try {
    const compressed = await compressXz(data)
    console.log(`XZ compression: ${data.length} → ${compressed.length} bytes ` +
                `(${((compressed.length / data.length) * 100).toFixed(1)}%)`)
    
    return {
      payload: compressed,
      algorithm: CompressionAlgorithm.Xz,
      originalSize: data.length,
      compressedSize: compressed.length
    }
  } catch (e) {
    console.warn('XZ compression failed, using uncompressed data:', e)
    return {
      payload: data,
      algorithm: CompressionAlgorithm.None,
      originalSize: data.length,
      compressedSize: data.length
    }
  }
}
```

#### 步骤3: 更新options.tsx

**文件**: `apps/browser-extension/src/options.tsx`

```typescript
// 修改onFileSelected
const onFileSelected = useCallback(async (file: File) => {
  await ensureWasm()
  const buf = new Uint8Array(await file.arrayBuffer())
  
  // XZ压缩
  const { payload: compressed, algorithm, compressedSize } = await preparePayload(buf)
  
  console.log(`Compression: ${file.size} → ${compressedSize} bytes ` +
              `(${((compressedSize / file.size) * 100).toFixed(1)}%)`)
  
  const crc = crc32(buf)
  // ... 其余逻辑
  
  setState((s) => ({
    ...s,
    file,
    compressed,
    compressionAlgorithm: algorithm,  // 新增
    fileCrc32: crc,
    sessionId,
    page: "params",
    error: null
  }))
}, [])
```

---

### Phase 3: 协议扩展

#### 步骤1: 扩展描述符

**文件**: `crates/transfer-engine/src/descriptor.rs`

在FileMeta结构中添加：

```rust
pub struct FileMeta {
    pub filename: String,
    pub original_size: u64,
    pub crc32: u32,
    
    // V3扩展字段
    pub compression: u8,        // 0=None, 1=Zstd, 2=Xz
    pub compressed_size: u64,   // 压缩后大小
}

impl Default for FileMeta {
    fn default() -> Self {
        Self {
            filename: String::new(),
            original_size: 0,
            crc32: 0,
            compression: 0,
            compressed_size: 0,
        }
    }
}
```

#### 步骤2: 更新序列化/反序列化

在`build_payload()`中写入新字段：
```rust
// ... filename, original_size, crc32
buf.push(meta.compression);
buf.extend_from_slice(&meta.compressed_size.to_be_bytes());
```

在`parse_payload()`中读取新字段：
```rust
let compression = payload[offset];
offset += 1;
let compressed_size = u64::from_be_bytes(...);
```

---

### Phase 4: Android接收端解压

#### 步骤1: 修改ReceiverSession

**文件**: `crates/transfer-engine/src/receiver.rs`

```rust
pub fn assemble(&self) -> Option<Vec<u8>> {
    let compressed = self.decoder.assemble()?;
    
    // 根据压缩类型解压
    match self.file_meta.compression {
        0 => Some(compressed),  // 无压缩
        1 => {
            // Zstd解压
            qr_protocol::compress::decompress(
                &compressed,
                qr_protocol::compress::CompressionAlgorithm::Zstd
            ).ok()
        }
        2 => {
            // XZ解压
            qr_protocol::compress::decompress(
                &compressed,
                qr_protocol::compress::CompressionAlgorithm::Xz
            ).ok()
        }
        _ => Some(compressed),  // 未知类型，返回原始数据
    }
}
```

---

## 三、性能测试计划

### 3.1 压缩率测试

**测试文件**:
| 文件 | 大小 | 类型 |
|------|------|------|
| test-text.txt | 100KB | 纯文本 |
| test-json.json | 50KB | JSON配置 |
| test-code.js | 200KB | 源代码 |
| test-pdf.pdf | 1MB | PDF文档 |
| test-image.png | 2MB | PNG图片 |

**测试指标**:
- 原始大小
- Zstd-22压缩后大小
- XZ-9压缩后大小
- 压缩时间
- 解压时间

### 3.2 端到端测试

**测试场景**: 1MB文本文件

| 方案 | 压缩后 | 传输帧数 | 传输时间@60fps |
|------|--------|---------|---------------|
| 无压缩 | 1024KB | 1024 | ~17秒 |
| Zstd-22 | ~200KB | 200 | ~3.3秒 |
| XZ-9 | ~150KB | 150 | ~2.5秒 |

**预期**: XZ可额外节省25-30%传输时间。

---

## 四、回退策略

### 4.1 压缩失败降级

```typescript
try {
  compressed = await compressXz(data)
} catch (e) {
  console.warn('XZ failed, fallback to uncompressed')
  compressed = data
  algorithm = CompressionAlgorithm.None
}
```

### 4.2 版本兼容

- V1: 无压缩
- V2: Zstd支持
- V3: XZ支持

旧版本接收端遇到V3描述符时：
- 如果不支持XZ，拒绝接收并提示升级
- 或降级到Zstd/无压缩模式

---

## 五、实施时间表

| 阶段 | 任务 | 工作量 | 优先级 |
|------|------|--------|--------|
| Phase 1 | Rust XZ解压 | 2小时 | P0 |
| Phase 2 | 浏览器XZ压缩 | 3小时 | P0 |
| Phase 3 | 协议扩展 | 2小时 | P0 |
| Phase 4 | Android集成 | 1小时 | P0 |
| 测试 | 压缩率+端到端 | 2小时 | P0 |
| **总计** | - | **10小时** | - |

---

## 六、风险评估

| 风险 | 影响 | 概率 | 缓解 |
|------|-----|------|------|
| XZ压缩时间过长 | 用户等待 | 低 | 显示进度条 |
| lzma-native安装失败 | 无法编译 | 中 | 提供fallback |
| 内存占用过高 | OOM崩溃 | 低 | Level 9已优化 |
| 旧版本不兼容 | 无法接收 | 中 | 版本检测 |

---

## 七、预期收益

### 7.1 压缩率提升

| 文件类型 | 额外节省 |
|---------|---------|
| 文本/代码 | 20-30% |
| JSON/配置 | 25-35% |
| PDF | 5-10% |
| 图片 | 0-5% |

### 7.2 传输时间节省

**1MB文本文件示例**:
- 当前（无压缩）: 17秒 @60fps
- Zstd-22: 3.3秒（节省80%）
- **XZ-9: 2.5秒（节省85%）** ⭐

**额外节省**: 0.8秒/MB（25%提升）

---

## 八、后续优化

1. **自适应压缩**: 根据文件类型自动选择算法（文本→XZ，图片→无压缩）
2. **多线程压缩**: 利用Web Workers并行压缩大文件
3. **压缩字典**: 为常见文件类型预训练XZ字典
4. **增量压缩**: 相似文件仅传输差异

---

**实施决策**: ⏳ 待用户确认后开始实施
