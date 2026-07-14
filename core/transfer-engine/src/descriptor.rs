//! Session descriptor frames.
//!
//! A *descriptor frame* is a regular wire frame whose payload (instead of a
//! RaptorQ symbol) carries the authoritative [`ObjectMeta`] needed by a
//! receiver to build its decoder, plus (v2) the file metadata (filename,
//! original size, CRC32). It is flagged with `FLAG_DESCRIPTOR` in the header.
//!
//! The sender emits a descriptor frame every `N` data frames so that a
//! receiver that joins mid-stream learns the object layout within seconds.

use crate::{Error, Result};
use qr_protocol::{frame::FLAG_DESCRIPTOR, Frame};
use raptorq_core::ObjectMeta;
use std::vec::Vec;

/// File metadata carried alongside the RaptorQ object metadata.
///
/// Kept separate from `ObjectMeta` so that the `meta != self.meta` equality
/// check in the receiver (which gates decoder rebuilds) is unaffected by
/// filename / checksum changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMeta {
    /// Original filename (UTF-8). May be truncated for very large block counts.
    pub filename: String,
    /// Original file size in bytes (before compression).
    pub original_size: u64,
    /// CRC32 of the original file bytes (for post-recovery verification).
    pub crc32: u32,
    /// Compression algorithm applied to the payload before RaptorQ encoding.
    /// Mirrors [`qr_protocol::compress`] constants: 0=None, 1=Zstd, 2=Xz.
    pub compression: u8,
    /// Size in bytes of the *compressed* payload that was RaptorQ-encoded.
    /// Receivers truncate RaptorQ zero-padding back to this before decompress.
    pub compressed_size: u64,
    /// Whether `compressed_size` carries a real value (vs. "unknown").
    ///
    /// This is a *runtime-only* flag — it is **not** serialized. It exists so
    /// the receiver can distinguish a genuinely empty payload (0 bytes) from
    /// "the descriptor never supplied this field" (e.g. a v1/v2 descriptor or a
    /// `FileMeta::default()`). The previous design used `compressed_size == 0`
    /// as a sentinel for "unknown", which silently broke empty/tiny payloads.
    pub compressed_size_known: bool,
    /// Whether `crc32` carries a real value (vs. "unknown").
    ///
    /// Like `compressed_size_known`, this is a *runtime-only* flag (not on the
    /// wire). CRC32 is a 32-bit hash whose output can legitimately be 0, so the
    /// old `crc32 == 0` sentinel for "unknown" mislabelled ~1 in 2^32 files as
    /// unverified. The descriptor v3 tail always carries a real CRC; v1 and
    /// `FileMeta::default()` set this false so the receiver skips verification
    /// instead of comparing against a meaningless 0.
    pub crc32_known: bool,
}

impl Default for FileMeta {
    fn default() -> Self {
        Self {
            filename: String::new(),
            original_size: 0,
            crc32: 0,
            compression: qr_protocol::compress::COMPRESSION_NONE,
            compressed_size: 0,
            compressed_size_known: false,
            crc32_known: false,
        }
    }
}

/// Parsed descriptor info: codec metadata + optional file metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescriptorInfo {
    pub meta: ObjectMeta,
    pub file_meta: FileMeta,
}

/// Compact on-wire descriptor layout (big-endian):
///   u8  magic        = 0xD5
///   u8  version      = 3
///   u16 num_blocks
///   u64 transfer_length
///   u32 symbol_size
///   u8[12] oti_bytes
///   repeated num_blocks × { u32 sbn, u32 num_source_symbols, u64 block_length }
///   --- v2 extension ---
///   u8  filename_len (0..=255)
///   u8[filename_len] filename (UTF-8)
///   u64 original_file_size
///   u32 crc32
///   --- v3 extension ---
///   u8  compression         (0=None, 1=Zstd, 2=Xz)
///   u64 compressed_size     (compressed payload bytes, before RaptorQ padding)
///
/// Total v1 part = 28 + 16*B. v2 extension = 1 + filename_len + 8 + 4.
/// v3 extension = 1 + 8 = 9.
/// Must fit in one symbol payload (default 1024 bytes).
const DESC_MAGIC: u8 = 0xD5;
const DESC_VERSION: u8 = 3;
const DESC_FIXED_OVERHEAD: usize = 28;
/// Size of the v2 extension fields excluding the variable filename bytes:
/// u8 filename_len + u64 original_size + u32 crc32 = 13.
const DESC_V2_TAIL_FIXED: usize = 13;
/// Size of the v3 extension fields: u8 compression + u64 compressed_size = 9.
const DESC_V3_TAIL_FIXED: usize = 9;

/// Serialize object metadata + file metadata into a descriptor payload, padded
/// with zeros to `symbol_size` bytes.
pub fn build_payload(meta: &ObjectMeta, file_meta: &FileMeta) -> Result<Vec<u8>> {
    let symbol_size = meta.symbol_size as usize;

    // Truncate filename if needed so the whole payload fits in one symbol.
    let blocks_len = meta.blocks.len() * 16;
    let available_for_filename = symbol_size
        .saturating_sub(DESC_FIXED_OVERHEAD + blocks_len + DESC_V2_TAIL_FIXED + DESC_V3_TAIL_FIXED);
    let filename_bytes = file_meta.filename.as_bytes();
    let filename_len = filename_bytes.len().min(available_for_filename).min(255);
    let filename_slice = &filename_bytes[..filename_len];

    // body = fixed overhead + blocks + (filename_len byte + filename) + v2 tail
    // (without its leading filename_len byte, already counted) + v3 tail.
    let body_len = DESC_FIXED_OVERHEAD + blocks_len + 1 + filename_len + DESC_V2_TAIL_FIXED - 1
        + DESC_V3_TAIL_FIXED;
    if body_len > symbol_size {
        return Err(Error::Protocol(qr_protocol::Error::BufferTooShort {
            need: body_len,
            have: symbol_size,
        }));
    }

    let mut buf = vec![0u8; symbol_size];
    buf[0] = DESC_MAGIC;
    buf[1] = DESC_VERSION;
    buf[2..4].copy_from_slice(&(meta.blocks.len() as u16).to_be_bytes());
    buf[4..12].copy_from_slice(&meta.transfer_length.to_be_bytes());
    buf[12..16].copy_from_slice(&meta.symbol_size.to_be_bytes());
    buf[16..28].copy_from_slice(&meta.oti_bytes);

    let mut o = DESC_FIXED_OVERHEAD;
    for b in &meta.blocks {
        buf[o..o + 4].copy_from_slice(&b.sbn.to_be_bytes());
        o += 4;
        buf[o..o + 4].copy_from_slice(&b.num_source_symbols.to_be_bytes());
        o += 4;
        buf[o..o + 8].copy_from_slice(&b.block_length.to_be_bytes());
        o += 8;
    }

    // v2 extension: filename + original_size + crc32.
    buf[o] = filename_len as u8;
    o += 1;
    buf[o..o + filename_len].copy_from_slice(filename_slice);
    o += filename_len;
    buf[o..o + 8].copy_from_slice(&file_meta.original_size.to_be_bytes());
    o += 8;
    buf[o..o + 4].copy_from_slice(&file_meta.crc32.to_be_bytes());
    o += 4;

    // v3 extension: compression + compressed_size.
    buf[o] = file_meta.compression;
    o += 1;
    buf[o..o + 8].copy_from_slice(&file_meta.compressed_size.to_be_bytes());

    Ok(buf)
}

/// Parse a descriptor payload. Accepts v1, v2, and v3 descriptors.
///
/// **Forward-compatibility by length + content, not version byte alone.** The
/// version field is only a hint. The catch: a descriptor payload is *always*
/// zero-padded up to a full symbol, so a genuine v2 sender (which stops writing
/// after the v2 crc32 field) leaves 9+ trailing zero bytes — exactly the size of
/// the v3 tail. A naive "are there ≥ 9 trailing bytes?" check would therefore
/// read that all-zero padding as a v3 tail (`compression=0, compressed_size=0`),
/// and because `compressed_size_known` would be set true, the receiver would
/// `truncate(0)` the recovered payload into an empty file. We guard against this
/// by treating the v3 tail as present only when the version byte claims ≥ 3 *or*
/// the tail is not the all-zero pattern a v2 sender's padding produces.
///
/// Returns `None` only if the payload is not a descriptor at all (bad magic or
/// truncated below the fixed header + declared block table).
pub fn parse_payload(payload: &[u8]) -> Option<DescriptorInfo> {
    if payload.len() < DESC_FIXED_OVERHEAD || payload[0] != DESC_MAGIC {
        return None;
    }
    let version = payload[1];

    let num_blocks = u16::from_be_bytes([payload[2], payload[3]]) as usize;
    let blocks_end = DESC_FIXED_OVERHEAD + num_blocks * 16;
    if payload.len() < blocks_end {
        return None;
    }

    let transfer_length = u64::from_be_bytes(payload[4..12].try_into().unwrap());
    let symbol_size = u32::from_be_bytes(payload[12..16].try_into().unwrap());
    let mut oti_bytes = [0u8; 12];
    oti_bytes.copy_from_slice(&payload[16..28]);

    let mut blocks = Vec::with_capacity(num_blocks);
    let mut o = DESC_FIXED_OVERHEAD;
    for _ in 0..num_blocks {
        let sbn = u32::from_be_bytes(payload[o..o + 4].try_into().unwrap());
        o += 4;
        let num_source_symbols = u32::from_be_bytes(payload[o..o + 4].try_into().unwrap());
        o += 4;
        let block_length = u64::from_be_bytes(payload[o..o + 8].try_into().unwrap());
        o += 8;
        blocks.push(raptorq_core::SourceBlockMeta {
            sbn,
            num_source_symbols,
            block_length,
        });
    }

    let meta = ObjectMeta {
        transfer_length,
        symbol_size,
        oti_bytes,
        blocks,
    };

    // v2 extension: filename_len + filename + original_size + crc32.
    // Parsed purely on availability of trailing bytes (not on the version
    // byte), so this stays compatible with any future version that preserves
    // the v1/v2 layout prefix.
    let file_meta = if payload.len() > o {
        let fn_len = payload[o] as usize;
        o += 1;
        // Need filename bytes + u64 original_size + u32 crc32 = fn_len + 12.
        if payload.len() < o + fn_len + 12 {
            // Truncated v2 extension — return empty file meta.
            FileMeta::default()
        } else {
            let filename = String::from_utf8_lossy(&payload[o..o + fn_len]).to_string();
            o += fn_len;
            let original_size = u64::from_be_bytes(payload[o..o + 8].try_into().unwrap());
            o += 8;
            let crc32 = u32::from_be_bytes(payload[o..o + 4].try_into().unwrap());
            o += 4;

            // v3 extension: compression + compressed_size. The descriptor is
            // always zero-padded to a full symbol, so a genuine v2 sender leaves
            // an all-zero region here that a pure length-check would mistake for
            // "compressed_size = 0" (→ receiver truncates to empty). Only treat
            // the tail as a real v3 extension when the version byte advertises it
            // (>= 3) OR the bytes are not the all-zero v2-padding signature.
            let v3_present = payload.len() >= o + DESC_V3_TAIL_FIXED
                && (version >= DESC_VERSION
                    || payload[o..o + DESC_V3_TAIL_FIXED].iter().any(|&b| b != 0));
            if v3_present {
                let compression = payload[o];
                o += 1;
                let compressed_size = u64::from_be_bytes(payload[o..o + 8].try_into().unwrap());
                FileMeta {
                    filename,
                    original_size,
                    crc32,
                    compression,
                    compressed_size,
                    compressed_size_known: true,
                    crc32_known: true,
                }
            } else {
                FileMeta {
                    filename,
                    original_size,
                    crc32,
                    compression: qr_protocol::compress::COMPRESSION_NONE,
                    // v2/v1 never carries a compressed payload length: assume the
                    // RaptorQ object is exactly the original file (no compression,
                    // no trimming). `compressed_size_known=false` would also be
                    // defensible, but the v3 spec defines the uncompressed case as
                    // "payload == original_size", so mirror that to stay correct
                    // for the (theoretical) v2 single-file sender.
                    compressed_size: original_size,
                    compressed_size_known: true,
                    crc32_known: true,
                }
            }
        }
    } else {
        // v1 descriptor — no file metadata.
        FileMeta::default()
    };

    Some(DescriptorInfo { meta, file_meta })
}

/// Build a descriptor frame ready for transmission.
pub fn build_frame(
    meta: &ObjectMeta,
    file_meta: &FileMeta,
    session_id: u128,
    frame_index: u64,
    timestamp_ms: u64,
) -> Result<Frame> {
    let payload = build_payload(meta, file_meta)?;
    Ok(Frame::build(
        session_id,
        FLAG_DESCRIPTOR,
        0,
        0,
        meta.blocks.len() as u32,
        meta.blocks.iter().map(|b| b.num_source_symbols).sum(),
        meta.symbol_size,
        frame_index,
        timestamp_ms,
        &payload,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sender::{SenderConfig, SenderSession};
    use qr_protocol::SessionId;

    /// Build a v3 descriptor's payload, then simulate exactly what a *real* v2
    /// sender would have produced: drop the v3 tail and zero-fill the rest of the
    /// symbol. This is the layout an actual legacy v2 endpoint writes (it stops
    /// after crc32 and pads with zeros), distinct from the old test which kept the
    /// v3 bytes around and only changed the version byte.
    fn build_real_v2_payload(meta: &ObjectMeta, file_meta: &FileMeta) -> Vec<u8> {
        let mut full = build_payload(meta, file_meta).unwrap();
        // Recompute where the v2 body ends (fixed + blocks + fn_len + filename +
        // original_size + crc32) and clear everything from there to the end of the
        // symbol, exactly as a real v2 sender's zero-pad would.
        let blocks_len = meta.blocks.len() * 16;
        let fn_len = file_meta.filename.len();
        let v2_body_end = DESC_FIXED_OVERHEAD + blocks_len + 1 + fn_len + 8 + 4;
        full[1] = 2; // downgrade version byte
        for b in &mut full[v2_body_end..] {
            *b = 0;
        }
        full
    }

    #[test]
    fn descriptor_roundtrip_v3() {
        let data: Vec<u8> = (0..50_000).map(|i| (i & 0xff) as u8).collect();
        let sender = SenderSession::new(
            &data,
            SessionId::zero(),
            SenderConfig::default(),
            FileMeta {
                filename: "test文档.pdf".to_string(),
                original_size: 50_000,
                crc32: 0xDEADBEEF,
                compression: qr_protocol::compress::COMPRESSION_NONE,
                compressed_size: 50_000,
                compressed_size_known: true,
                crc32_known: true,
            },
        )
        .unwrap();
        let meta = sender.meta().clone();
        let file_meta = sender.file_meta().clone();
        let payload = build_payload(&meta, &file_meta).unwrap();
        assert_eq!(payload.len(), 1024);
        let info = parse_payload(&payload).unwrap();
        assert_eq!(info.meta, meta);
        assert_eq!(info.file_meta.filename, "test文档.pdf");
        assert_eq!(info.file_meta.original_size, 50_000);
        assert_eq!(info.file_meta.crc32, 0xDEADBEEF);
        assert_eq!(
            info.file_meta.compression,
            qr_protocol::compress::COMPRESSION_NONE
        );
        assert_eq!(info.file_meta.compressed_size, 50_000);
        assert!(info.file_meta.crc32_known);
    }

    #[test]
    fn descriptor_roundtrip_v3_compressed() {
        // Simulate a zstd-compressed payload: original 50KB, compressed 18KB.
        let data: Vec<u8> = (0..50_000).map(|i| (i & 0xff) as u8).collect();
        let sender = SenderSession::new(
            &data,
            SessionId::zero(),
            SenderConfig::default(),
            FileMeta {
                filename: "doc.json".to_string(),
                original_size: 50_000,
                crc32: 0xCAFEBABE,
                compression: qr_protocol::compress::COMPRESSION_ZSTD,
                compressed_size: 18_000,
                compressed_size_known: true,
                crc32_known: true,
            },
        )
        .unwrap();
        let meta = sender.meta().clone();
        let file_meta = sender.file_meta().clone();
        let payload = build_payload(&meta, &file_meta).unwrap();
        assert_eq!(payload[1], DESC_VERSION);
        let info = parse_payload(&payload).unwrap();
        assert_eq!(
            info.file_meta.compression,
            qr_protocol::compress::COMPRESSION_ZSTD
        );
        assert_eq!(info.file_meta.compressed_size, 18_000);
        assert_eq!(info.file_meta.original_size, 50_000);
        assert_eq!(info.file_meta.crc32, 0xCAFEBABE);
        assert!(info.file_meta.crc32_known);
    }

    /// A genuine v2 descriptor — exactly what a real legacy v2 sender transmits:
    /// the v2 body (through crc32) followed by an all-zero padded tail. This must
    /// NOT be misread as a v3 tail with `compressed_size = 0` (which would make
    /// the receiver truncate the recovered payload to an empty file). The fix
    /// treats an all-zero trailing region as v2 padding, not a v3 extension.
    #[test]
    fn real_v2_descriptor_is_not_misread_as_empty_v3() {
        let data: Vec<u8> = (0..50_000).map(|i| (i & 0xff) as u8).collect();
        let sender = SenderSession::new(
            &data,
            SessionId::zero(),
            SenderConfig::default(),
            FileMeta::default(),
        )
        .unwrap();
        let meta = sender.meta().clone();
        let v2 = build_real_v2_payload(
            &meta,
            &FileMeta {
                filename: "legacy.bin".to_string(),
                original_size: 1_234,
                crc32: 0x11223344,
                compression: qr_protocol::compress::COMPRESSION_NONE,
                compressed_size: 1_234,
                compressed_size_known: true,
                crc32_known: true,
            },
        );

        let info = parse_payload(&v2).unwrap();
        // The v2 fields are intact.
        assert_eq!(info.file_meta.filename, "legacy.bin");
        assert_eq!(info.file_meta.original_size, 1_234);
        assert_eq!(info.file_meta.crc32, 0x11223344);
        // The all-zero tail must NOT be read as a v3 extension claiming a 0-byte
        // compressed payload — that would truncate the recovered file to empty.
        assert_eq!(
            info.file_meta.compression,
            qr_protocol::compress::COMPRESSION_NONE
        );
        assert_eq!(
            info.file_meta.compressed_size, 1_234,
            "v2 descriptor must fall back to compressed_size == original_size, not 0"
        );
    }

    /// Regression for the full bug: a receiver fed a real v2 descriptor must
    /// recover the original bytes, not an empty file. Before the fix, the all-zero
    /// padding was parsed as a v3 tail with compressed_size=0, so assemble()
    /// truncated the payload to 0 bytes.
    #[test]
    fn receiver_recovers_from_real_v2_descriptor_not_empty() {
        use crate::receiver::ReceiverSession;
        use raptorq_core::Config;

        let data: Vec<u8> = (0..40_000).map(|i| (i & 0xff) as u8).collect();
        // Build the sender with FileMeta whose compressed_size equals the padded
        // transfer length (the uncompressed path), then craft a real v2 descriptor
        // that drops the v3 tail and zero-pads.
        let probe = SenderSession::new(
            &data,
            SessionId::zero(),
            SenderConfig {
                codec: Config::default(),
                redundancy_pct: 20,
            },
            FileMeta::default(),
        )
        .unwrap();
        let meta = probe.meta().clone();
        let padded_len = meta.transfer_length;
        let fm = FileMeta {
            filename: "legacy.bin".to_string(),
            original_size: data.len() as u64,
            crc32: 0,
            compression: qr_protocol::compress::COMPRESSION_NONE,
            compressed_size: padded_len,
            compressed_size_known: true,
            crc32_known: false,
        };
        let mut sender = SenderSession::new(
            &data,
            SessionId::zero(),
            SenderConfig {
                codec: Config::default(),
                redundancy_pct: 20,
            },
            fm,
        )
        .unwrap();
        sender.set_descriptor_interval(8);

        // Drive a receiver purely from frames, mimicking the wire path.
        let first = sender.next_frame().unwrap();
        let mut rx =
            ReceiverSession::from_first_frame(&Frame::from_bytes(&first.to_bytes()).unwrap());
        let mut guard = 0;
        while !rx.is_complete() {
            let f = sender.next_frame().unwrap();
            let parsed = Frame::from_bytes(&f.to_bytes()).unwrap();
            let _ = rx.ingest(parsed);
            guard += 1;
            assert!(guard < 400_000, "v2 receiver did not recover");
        }
        let out = rx.assemble().expect("must assemble");
        // The killer assertion: recovered bytes are the full file, NOT empty.
        assert_eq!(
            &out[..data.len()],
            &data[..],
            "v2 descriptor must not truncate the recovered payload to empty"
        );
    }

    #[test]
    fn rejects_non_descriptor() {
        assert!(parse_payload(&[0u8; 1024]).is_none());
    }
}
