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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileMeta {
    /// Original filename (UTF-8). May be truncated for very large block counts.
    pub filename: String,
    /// Original file size in bytes (before padding/encoding).
    pub original_size: u64,
    /// CRC32 of the original file bytes (for post-recovery verification).
    pub crc32: u32,
}

/// Parsed descriptor info: codec metadata + optional file metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescriptorInfo {
    pub meta: ObjectMeta,
    pub file_meta: FileMeta,
}

/// Compact on-wire descriptor layout (big-endian):
///   u8  magic        = 0xD5
///   u8  version      = 2
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
///
/// Total v1 part = 28 + 16*B. v2 extension = 1 + filename_len + 8 + 4.
/// Must fit in one symbol payload (default 1024 bytes).
const DESC_MAGIC: u8 = 0xD5;
const DESC_VERSION: u8 = 2;
const DESC_FIXED_OVERHEAD: usize = 28;
/// Size of the v2 extension fields excluding the variable filename bytes:
/// u8 filename_len + u64 original_size + u32 crc32 = 13.
const DESC_V2_TAIL_FIXED: usize = 13;

/// Serialize object metadata + file metadata into a descriptor payload, padded
/// with zeros to `symbol_size` bytes.
pub fn build_payload(meta: &ObjectMeta, file_meta: &FileMeta) -> Result<Vec<u8>> {
    let symbol_size = meta.symbol_size as usize;

    // Truncate filename if needed so the whole payload fits in one symbol.
    let blocks_len = meta.blocks.len() * 16;
    let available_for_filename = symbol_size
        .saturating_sub(DESC_FIXED_OVERHEAD + blocks_len + DESC_V2_TAIL_FIXED);
    let filename_bytes = file_meta.filename.as_bytes();
    let filename_len = filename_bytes.len().min(available_for_filename).min(255);
    let filename_slice = &filename_bytes[..filename_len];

    let body_len = DESC_FIXED_OVERHEAD + blocks_len + 1 + filename_len + DESC_V2_TAIL_FIXED - 1;
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

    Ok(buf)
}

/// Parse a descriptor payload. Accepts both v1 (no file meta) and v2.
/// Returns `None` if the payload is not a valid descriptor.
pub fn parse_payload(payload: &[u8]) -> Option<DescriptorInfo> {
    if payload.len() < DESC_FIXED_OVERHEAD || payload[0] != DESC_MAGIC {
        return None;
    }
    let version = payload[1];
    if version > DESC_VERSION {
        // Unknown future version — reject.
        return None;
    }

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

    // Parse v2 extension if present.
    let file_meta = if version >= 2 && payload.len() >= o + 1 {
        let fn_len = payload[o] as usize;
        o += 1;
        if payload.len() < o + fn_len + 12 {
            // Truncated v2 extension — return empty file meta.
            FileMeta::default()
        } else {
            let filename = String::from_utf8_lossy(&payload[o..o + fn_len]).to_string();
            o += fn_len;
            let original_size = u64::from_be_bytes(payload[o..o + 8].try_into().unwrap());
            o += 8;
            let crc32 = u32::from_be_bytes(payload[o..o + 4].try_into().unwrap());
            FileMeta {
                filename,
                original_size,
                crc32,
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

    #[test]
    fn descriptor_roundtrip_v2() {
        let data: Vec<u8> = (0..50_000).map(|i| (i & 0xff) as u8).collect();
        let sender = SenderSession::new(
            &data,
            SessionId::zero(),
            SenderConfig::default(),
            FileMeta {
                filename: "test文档.pdf".to_string(),
                original_size: 50_000,
                crc32: 0xDEADBEEF,
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
    }

    #[test]
    fn rejects_non_descriptor() {
        assert!(parse_payload(&[0u8; 1024]).is_none());
    }
}
