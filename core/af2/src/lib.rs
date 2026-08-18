//! # af2 — AirFerry Protocol 2 core
//!
//! Pure-Rust AF2 implementation (wire spec: `docs/SPEC.md`). The v1
//! artifacts were deleted with the Phase F cutover; `transfer-engine` now
//! binds this crate directly.
//!
//! Layout:
//! - [`frame`]: 26B-header wire frames (ROOT / OBJECT_META / SYMBOL)
//! - [`id`]: BLAKE3-256 hash domain + three-layer identity derivation
//! - [`tlv`]: four-scope TLV codec with the Critical fail-closed rule
//! - [`root`], [`meta`], [`manifest`]: record codecs (Phase C2)
//! - [`chunk`]: per-chunk RAW/Zstd/Xz bounded codec (Phase C4)
//! - [`receiver`]: Idle→Locked→Decode→Ready state machine (Phase C5)

pub mod chunk;
pub mod frame;
pub mod id;
pub mod manifest;
pub mod meta;
pub mod receiver;
pub mod root;
pub mod sender;
pub mod tlv;

pub use frame::{Af2Frame, FrameError, FrameType, HEADER_SIZE, MAX_ESI, MAX_SBN};
pub use id::{
    content_id, empty_hash, hash, object_id, transfer_id, EntryIdInput, ROLE_CHUNK, ROLE_MANIFEST,
};
pub use manifest::sanitize_save_paths;
pub use receiver::{Af2Receiver, FinalStreamVerifier, IngestEvent};
pub use sender::{
    Af2Sender, ChunkSegment, PreencodedChunk, SenderConfig, SenderError, plan_chunks,
};
pub use tlv::{parse_tlvs, Tlv, TlvError};

/// Common error type across AF2 parsing surfaces.
#[derive(Debug, thiserror::Error)]
pub enum Af2Error {
    #[error("frame error: {0}")]
    Frame(#[from] FrameError),
    #[error("tlv error: {0}")]
    Tlv(#[from] TlvError),
}
