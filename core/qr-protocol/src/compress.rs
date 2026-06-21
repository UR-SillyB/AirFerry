//! Unified compression interface (Zstd + XZ/LZMA2).
//!
//! Only available on native / Android targets. On `wasm32-unknown-unknown` the
//! underlying C libraries do not compile, so the browser extension performs
//! compression on the JavaScript side (using the same standard zstd format)
//! before handing the bytes to the Rust core. The on-wire format is identical,
//! so bytes compressed on one side decompress correctly on the other.
//!
//! ## Algorithm selection
//!
//! The wire protocol tags every transfer with a [`COMPRESSION_*`] byte so the
//! receiver knows which decoder to run. Zstd is the default and works
//! end-to-end today; XZ (LZMA2) gives a better ratio for text-heavy payloads
//! but is currently only wired into the Rust decompressor (the browser has no
//! stable XZ compressor), so it is reserved for future use.

#![cfg_attr(target_arch = "wasm32", allow(dead_code))]

#[cfg(not(target_arch = "wasm32"))]
use crate::Error;
use crate::Result;

/// Maximum compression level for small files where compression time is negligible.
/// Using level 22 (maximum) for best compression ratio on typical small files (<10MB).
pub const DEFAULT_LEVEL: i32 = 22;

/// Compression-algorithm tags carried in the descriptor (1 byte, big-endian).
pub const COMPRESSION_NONE: u8 = 0;
pub const COMPRESSION_ZSTD: u8 = 1;
pub const COMPRESSION_XZ: u8 = 2;

/// XZ/LZMA2 preset. The low 5 bits are the compression level (0..=9); bit 31
/// is `LZMA_PRESET_EXTREME` (0x8000_0000), which enables a much slower but
/// higher-ratio search at the given level.
///
/// We use level 6 (the default for xz tools) with the EXTREME flag. Level 9
/// peaks at ~700 MB of memory on the *decoder* side, which OOMs the typical
/// Android JVM heap (256 MB); level 6 keeps the decoder footprint around
/// ~95 MB while still compressing text-heavy payloads well.
///
/// NOTE: the browser sender (`compress.ts`) uses level 9. The two presets
/// produce *interoperable* .xz streams (any compliant LZMA2 reader handles
/// either), so the cross-language link is correct — only the ratio/speed
/// trade-off differs per side. See `XZ_COMPRESSION_PLAN.md` for the rationale.
#[cfg(not(target_arch = "wasm32"))]
const LZMA_PRESET_EXTREME: u32 = 0x8000_0000;
#[cfg(not(target_arch = "wasm32"))]
const XZ_PRESET: u32 = 6 | LZMA_PRESET_EXTREME;

/// Compress `data` with zstd at the given level.
/// For small files, uses maximum compression (level 22) by default.
#[cfg(not(target_arch = "wasm32"))]
pub fn compress(data: &[u8], level: i32) -> Result<Vec<u8>> {
    zstd::encode_all(data, level).map_err(|e| Error::Compress(e.to_string()))
}

/// Decompress zstd-encoded `data`. (Kept for backward compatibility.)
#[cfg(not(target_arch = "wasm32"))]
pub fn decompress(data: &[u8]) -> Result<Vec<u8>> {
    zstd::decode_all(data).map_err(|e| Error::Compress(e.to_string()))
}

/// Compress `data` with the algorithm identified by a [`COMPRESSION_*`] tag.
///
/// `COMPRESSION_NONE` returns the bytes unchanged. Unknown tags are treated as
/// no compression so a receiver never fails purely on an unrecognized algo.
#[cfg(not(target_arch = "wasm32"))]
pub fn compress_with(data: &[u8], compression: u8) -> Result<Vec<u8>> {
    match compression {
        COMPRESSION_ZSTD => compress(data, DEFAULT_LEVEL),
        COMPRESSION_XZ => xz_compress(data),
        _ => Ok(data.to_vec()),
    }
}

/// Decompress `data` using the algorithm identified by a [`COMPRESSION_*`] tag.
///
/// `COMPRESSION_NONE` (and any unrecognized tag) returns the bytes unchanged,
/// which keeps a descriptor/algorithm mismatch non-fatal.
#[cfg(not(target_arch = "wasm32"))]
pub fn decompress_with(data: &[u8], compression: u8) -> Result<Vec<u8>> {
    match compression {
        COMPRESSION_ZSTD => decompress(data),
        COMPRESSION_XZ => xz_decompress(data),
        _ => Ok(data.to_vec()),
    }
}

/// Like [`decompress_with`] but bounds the **output** size to `max_output` bytes.
///
/// The receiver decompresses data recovered from an untrusted optical stream. A
/// tiny zstd/xz payload can legitimately expand 1000×+ (a "decompression bomb"),
/// so without an output cap a crafted transfer would OOM the Android receiver at
/// assemble time. The caller passes the descriptor's expected original size as
/// the cap; if the stream produces more than that, it's rejected.
#[cfg(not(target_arch = "wasm32"))]
pub fn decompress_with_limit(data: &[u8], compression: u8, max_output: usize) -> Result<Vec<u8>> {
    match compression {
        COMPRESSION_ZSTD => {
            let dec = zstd::stream::read::Decoder::new(data)
                .map_err(|e| Error::Compress(e.to_string()))?;
            read_capped(dec, max_output)
        }
        COMPRESSION_XZ => read_capped(xz2::read::XzDecoder::new(data), max_output),
        _ => {
            if data.len() > max_output {
                return Err(Error::Compress("payload exceeds size limit".into()));
            }
            Ok(data.to_vec())
        }
    }
}

/// Read a decoder fully but refuse to produce more than `max_output` bytes.
#[cfg(not(target_arch = "wasm32"))]
fn read_capped<R: std::io::Read>(r: R, max_output: usize) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    // Read one byte past the cap so an over-limit stream can be detected.
    r.take(max_output as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| Error::Compress(e.to_string()))?;
    if out.len() > max_output {
        return Err(Error::Compress("decompressed output exceeds expected size".into()));
    }
    Ok(out)
}

/// Stub for wasm32 (receiver never runs in the browser).
#[cfg(target_arch = "wasm32")]
pub fn decompress_with_limit(data: &[u8], _compression: u8, _max_output: usize) -> Result<Vec<u8>> {
    Ok(data.to_vec())
}

/// Stub for wasm32: the receiver is never exercised in the browser, but the
/// module must compile so that the transfer-engine crate links under wasm-pack.
#[cfg(target_arch = "wasm32")]
pub fn decompress_with(data: &[u8], _compression: u8) -> Result<Vec<u8>> {
    Ok(data.to_vec())
}

/// Compress `data` with XZ/LZMA2 at a high-ratio preset (level 6 + EXTREME).
///
/// Slower than zstd but yields a better ratio for text-heavy payloads. Memory
/// usage stays modest at this level (~95 MB decoder footprint), which keeps
/// the Android JVM heap (typically 256 MB) safe even on low-end devices.
#[cfg(not(target_arch = "wasm32"))]
fn xz_compress(data: &[u8]) -> Result<Vec<u8>> {
    use std::io::Write;
    let mut encoder = xz2::write::XzEncoder::new(Vec::new(), XZ_PRESET);
    encoder
        .write_all(data)
        .map_err(|e| Error::Compress(e.to_string()))?;
    encoder.finish().map_err(|e| Error::Compress(e.to_string()))
}

/// Decompress XZ/LZMA2-encoded `data`.
#[cfg(not(target_arch = "wasm32"))]
fn xz_decompress(data: &[u8]) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut decoder = xz2::read::XzDecoder::new(data);
    let mut output = Vec::new();
    decoder
        .read_to_end(&mut output)
        .map_err(|e| Error::Compress(e.to_string()))?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zstd_round_trip() {
        let data: Vec<u8> = (0..40_000).map(|i| (i & 0xff) as u8).collect();
        let c = compress(&data, DEFAULT_LEVEL).unwrap();
        let d = decompress(&c).unwrap();
        assert_eq!(d, data);
    }

    #[test]
    fn zstd_compressed_data_shrinks_for_repetitive_input() {
        let data = vec![0xABu8; 10_000];
        let c = compress(&data, DEFAULT_LEVEL).unwrap();
        assert!(c.len() < data.len());
    }

    #[test]
    fn xz_round_trip() {
        let data: Vec<u8> = (0..10_000).map(|i| (i & 0xff) as u8).collect();
        let compressed = xz_compress(&data).unwrap();
        let decompressed = xz_decompress(&compressed).unwrap();
        assert_eq!(decompressed, data);
    }

    #[test]
    fn xz_compresses_repetitive_input_aggressively() {
        let data = vec![0xABu8; 10_000];
        let compressed = xz_compress(&data).unwrap();
        // Highly repetitive input should compress well over 90% (the .xz stream
        // container itself costs ~60 bytes of header/footer/index).
        assert!(compressed.len() < data.len() / 10);
    }

    #[test]
    fn compress_with_and_decompress_with_dispatch() {
        let data: Vec<u8> = (0..8_000).map(|i| (i & 0xff) as u8).collect();

        // Zstd path.
        let z = compress_with(&data, COMPRESSION_ZSTD).unwrap();
        assert_eq!(decompress_with(&z, COMPRESSION_ZSTD).unwrap(), data);

        // XZ path.
        let x = compress_with(&data, COMPRESSION_XZ).unwrap();
        assert_eq!(decompress_with(&x, COMPRESSION_XZ).unwrap(), data);

        // None path is identity.
        assert_eq!(compress_with(&data, COMPRESSION_NONE).unwrap(), data);
        assert_eq!(decompress_with(&data, COMPRESSION_NONE).unwrap(), data);
    }

    #[test]
    fn unknown_compression_tag_is_identity() {
        let data = vec![1u8, 2, 3, 4];
        assert_eq!(compress_with(&data, 99).unwrap(), data);
        assert_eq!(decompress_with(&data, 99).unwrap(), data);
    }

    #[test]
    fn decompress_with_limit_rejects_bomb() {
        // Highly compressible input expands far beyond a tiny cap.
        let data = vec![0u8; 1_000_000];
        let z = compress(&data, DEFAULT_LEVEL).unwrap();
        assert!(z.len() < 10_000, "should compress tiny");
        // Cap below the true output → rejected (bomb defense).
        assert!(decompress_with_limit(&z, COMPRESSION_ZSTD, 1000).is_err());
        // Cap at the true output → ok.
        assert_eq!(decompress_with_limit(&z, COMPRESSION_ZSTD, data.len()).unwrap(), data);

        // XZ path behaves the same.
        let x = xz_compress(&data).unwrap();
        assert!(decompress_with_limit(&x, COMPRESSION_XZ, 1000).is_err());
        assert_eq!(decompress_with_limit(&x, COMPRESSION_XZ, data.len()).unwrap(), data);
    }
}
