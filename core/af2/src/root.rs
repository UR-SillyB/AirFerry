//! AF2 Root Record (protocol 2, §6).
//!
//! Fixed 112 bytes + TLVs; carried by a ROOT frame body. The receiver locks
//! the Transfer, builds its resource budget, and locates the Manifest from it.
//!
//! ```text
//! off  len  field
//! 0    4    magic ASCII "AFR2"
//! 4    1    schema = 1
//! 5    1    flags = 0
//! 6    2    fixed_len = 112
//! 8    2    extensions_len
//! 10   2    reserved = 0
//! 12   32   content_id
//! 44   16   manifest_object_id
//! 60   32   manifest_hash (uncompressed Manifest bytes)
//! 92   8    total_raw_size
//! 100  4    entry_count
//! 104  4    chunk_count
//! 108  4    chunk_raw_size
//! ```

use crate::id::{transfer_id, EntryIdInput};
use crate::id::content_id as compute_content_id;

pub const ROOT_MAGIC: &[u8; 4] = b"AFR2";
pub const ROOT_SCHEMA: u8 = 1;
pub const ROOT_FIXED_LEN: usize = 112;

/// Legal chunk_raw_size values (powers of two, 1..=32 MiB). Default 8 MiB.
pub const CHUNK_SIZES: [u32; 6] = [1 << 20, 2 << 20, 4 << 20, 8 << 20, 16 << 20, 32 << 20];
pub const DEFAULT_CHUNK_RAW_SIZE: u32 = 8 << 20;

pub const MAX_ENTRY_COUNT: u32 = 4096;
pub const MAX_CHUNK_COUNT: u32 = 131_072;
pub const MAX_TOTAL_RAW_SIZE: u64 = 4 << 40; // 4 TiB

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootRecord {
    pub content_id: [u8; 32],
    /// Transport parameter: allowed to change on a re-broadcast with a new T
    /// while the semantic fields stay identical.
    pub manifest_object_id: [u8; 16],
    pub manifest_hash: [u8; 32],
    pub total_raw_size: u64,
    pub entry_count: u32,
    pub chunk_count: u32,
    pub chunk_raw_size: u32,
    pub extensions: Vec<crate::tlv::Tlv>,
}

#[derive(Debug, thiserror::Error)]
pub enum RootError {
    #[error("root: bad magic")]
    BadMagic,
    #[error("root: unsupported schema {0}")]
    BadSchema(u8),
    #[error("root: fixed_len must be 112, got {0}")]
    BadFixedLen(u16),
    #[error("root: body_len mismatch (fixed+ext = {sum}, body = {body})")]
    BodyLenMismatch { sum: usize, body: usize },
    #[error("root: reserved field must be zero")]
    ReservedNotZero,
    #[error("root: flags must be zero, got {0:#x}")]
    FlagsNotZero(u8),
    #[error("root: entry_count {0} out of 1..=4096")]
    BadEntryCount(u32),
    #[error("root: chunk_raw_size {0:#x} not a legal power-of-two size")]
    BadChunkSize(u32),
    #[error("root: chunk_count {count} != ceil(total/chunk) = {expected}")]
    ChunkCountMismatch { count: u32, expected: u32 },
    #[error("root: chunk_count {0} exceeds 131072")]
    ChunkCountTooLarge(u32),
    #[error("root: total_raw_size {0} exceeds 4 TiB")]
    TotalTooLarge(u64),
    #[error("root: total_raw_size must be ≥ 1 (empty canonical stream is unrepresentable: RaptorQ cannot encode F=0)")]
    EmptyTransfer,
    #[error("root: {0}")]
    Tlv(#[from] crate::tlv::TlvError),
}

/// `chunk_count = ceil(total_raw_size / chunk_raw_size)` (SPEC §6). The
/// canonical stream must be non-empty (`total_raw_size ≥ 1` is enforced by
/// encode/parse), so the ceil is always ≥ 1 on any legal ROOT.
pub fn expected_chunk_count(total_raw_size: u64, chunk_raw_size: u32) -> u32 {
    u32::try_from(total_raw_size.div_ceil(u64::from(chunk_raw_size))).unwrap_or(u32::MAX)
}

impl RootRecord {
    pub fn encode(&self) -> Result<Vec<u8>, RootError> {
        if self.entry_count == 0 || self.entry_count > MAX_ENTRY_COUNT {
            return Err(RootError::BadEntryCount(self.entry_count));
        }
        if !CHUNK_SIZES.contains(&self.chunk_raw_size) {
            return Err(RootError::BadChunkSize(self.chunk_raw_size));
        }
        if self.total_raw_size == 0 {
            return Err(RootError::EmptyTransfer);
        }
        if self.total_raw_size > MAX_TOTAL_RAW_SIZE {
            return Err(RootError::TotalTooLarge(self.total_raw_size));
        }
        let expected = expected_chunk_count(self.total_raw_size, self.chunk_raw_size);
        if self.chunk_count != expected {
            return Err(RootError::ChunkCountMismatch {
                count: self.chunk_count,
                expected,
            });
        }
        if self.chunk_count > MAX_CHUNK_COUNT {
            return Err(RootError::ChunkCountTooLarge(self.chunk_count));
        }
        let ext = crate::tlv::encode_tlvs(&self.extensions)?;
        let mut out = Vec::with_capacity(ROOT_FIXED_LEN + ext.len());
        out.extend_from_slice(ROOT_MAGIC);
        out.push(ROOT_SCHEMA);
        out.push(0); // flags
        out.extend_from_slice(&(ROOT_FIXED_LEN as u16).to_be_bytes());
        out.extend_from_slice(&(ext.len() as u16).to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes());
        out.extend_from_slice(&self.content_id);
        out.extend_from_slice(&self.manifest_object_id);
        out.extend_from_slice(&self.manifest_hash);
        out.extend_from_slice(&self.total_raw_size.to_be_bytes());
        out.extend_from_slice(&self.entry_count.to_be_bytes());
        out.extend_from_slice(&self.chunk_count.to_be_bytes());
        out.extend_from_slice(&self.chunk_raw_size.to_be_bytes());
        debug_assert_eq!(out.len(), ROOT_FIXED_LEN);
        out.extend_from_slice(&ext);
        Ok(out)
    }

    pub fn parse(body: &[u8]) -> Result<Self, RootError> {
        if body.len() < ROOT_FIXED_LEN || &body[0..4] != ROOT_MAGIC {
            return Err(RootError::BadMagic);
        }
        if body[4] != ROOT_SCHEMA {
            return Err(RootError::BadSchema(body[4]));
        }
        if body[5] != 0 {
            return Err(RootError::FlagsNotZero(body[5]));
        }
        let fixed_len = u16::from_be_bytes([body[6], body[7]]) as usize;
        if fixed_len != ROOT_FIXED_LEN {
            return Err(RootError::BadFixedLen(fixed_len as u16));
        }
        let ext_len = u16::from_be_bytes([body[8], body[9]]) as usize;
        if body.len() != ROOT_FIXED_LEN + ext_len {
            return Err(RootError::BodyLenMismatch {
                sum: ROOT_FIXED_LEN + ext_len,
                body: body.len(),
            });
        }
        if body[10] != 0 || body[11] != 0 {
            return Err(RootError::ReservedNotZero);
        }
        let mut content = [0u8; 32];
        content.copy_from_slice(&body[12..44]);
        let mut manifest_object_id = [0u8; 16];
        manifest_object_id.copy_from_slice(&body[44..60]);
        let mut manifest_hash = [0u8; 32];
        manifest_hash.copy_from_slice(&body[60..92]);
        let total_raw_size = u64::from_be_bytes([
            body[92], body[93], body[94], body[95], body[96], body[97], body[98], body[99],
        ]);
        let entry_count = u32::from_be_bytes([body[100], body[101], body[102], body[103]]);
        let chunk_count = u32::from_be_bytes([body[104], body[105], body[106], body[107]]);
        let chunk_raw_size = u32::from_be_bytes([body[108], body[109], body[110], body[111]]);
        let extensions = crate::tlv::parse_tlvs(&body[ROOT_FIXED_LEN..])?;
        crate::tlv::check_unknown_critical(&extensions)?;
        let rec = RootRecord {
            content_id: content,
            manifest_object_id,
            manifest_hash,
            total_raw_size,
            entry_count,
            chunk_count,
            chunk_raw_size,
            extensions,
        };
        // Re-validate on parse (the same encode-side rules).
        rec.encode()?;
        Ok(rec)
    }

    /// Derive the Transfer ID for this root.
    pub fn transfer(&self) -> [u8; 16] {
        transfer_id(&self.manifest_hash, self.chunk_raw_size)
    }

    /// Recompute the content id from a manifest's entries (cross-check).
    pub fn matches_entries(&self, entries: &[EntryIdInput<'_>]) -> bool {
        compute_content_id(entries) == self.content_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> RootRecord {
        RootRecord {
            content_id: [0x11; 32],
            manifest_object_id: [0x22; 16],
            manifest_hash: [0x33; 32],
            total_raw_size: DEFAULT_CHUNK_RAW_SIZE as u64 + 100,
            entry_count: 2,
            chunk_count: 2,
            chunk_raw_size: DEFAULT_CHUNK_RAW_SIZE,
            extensions: vec![],
        }
    }

    #[test]
    fn round_trip() {
        let bytes = sample().encode().unwrap();
        assert_eq!(bytes.len(), ROOT_FIXED_LEN);
        assert_eq!(RootRecord::parse(&bytes).unwrap(), sample());
    }

    #[test]
    fn rejects_violations() {
        let mut r = sample();
        r.chunk_count = 3; // inconsistent with total/chunk
        assert!(matches!(
            r.encode(),
            Err(RootError::ChunkCountMismatch { .. })
        ));
        let mut r = sample();
        r.chunk_raw_size = 3 << 20; // not a power of two
        assert!(matches!(r.encode(), Err(RootError::BadChunkSize(sz)) if sz == (3 << 20)));
        let mut r = sample();
        r.entry_count = 0;
        assert!(matches!(r.encode(), Err(RootError::BadEntryCount(0))));
        let mut r = sample();
        r.total_raw_size = 0;
        r.chunk_count = 0; // keep the ceil formula happy; the empty check fires first
        assert!(matches!(r.encode(), Err(RootError::EmptyTransfer)));
        // tampered magic
        let mut bytes = sample().encode().unwrap();
        bytes[0] = b'X';
        assert!(matches!(RootRecord::parse(&bytes), Err(RootError::BadMagic)));
        // v1 ET descriptor body must not parse as ROOT
        assert!(matches!(
            RootRecord::parse(&[0xD5u8, 5, 0, 0]),
            Err(RootError::BadMagic)
        ));
    }
}
