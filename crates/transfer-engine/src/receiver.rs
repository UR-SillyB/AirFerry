//! Receiver-side session orchestration.

use crate::{progress::Progress, Error, Result};
use qr_protocol::{frame::SessionIdRaw, Frame};
use raptorq_core::{Decoder, ObjectMeta, Symbol};
use std::collections::{HashMap, HashSet};
use std::vec::Vec;

/// A receiver session.
///
/// Ingest frames (decoded QR payloads), feed the RaptorQ decoder, and report
/// recovery progress. The session is created lazily from the first valid frame
/// (which carries the totals needed to rebuild OTI via the encoder on the
/// sender side — but the receiver reconstructs OTI from the header totals and
/// the known symbol size).
///
/// For resume, use [`ReceiverSession::save_state`] / [`ReceiverSession::restore`].
pub struct ReceiverSession {
    session_id: SessionIdRaw,
    #[allow(dead_code)]
    symbol_size: u32,
    #[allow(dead_code)]
    total_blocks: u32,
    total_symbols: u32,
    decoder: Decoder,
    meta: ObjectMeta,
    /// Whether `meta` came from an authoritative descriptor frame (vs heuristic).
    meta_confirmed: bool,
    /// File metadata learned from the descriptor frame (filename, size, CRC32).
    file_meta: crate::descriptor::FileMeta,
    received: Vec<HashSet<u32>>,
    symbol_cache: HashMap<(u32, u32), Vec<u8>>,
    progress: Progress,
}

impl ReceiverSession {
    /// Create a receiver for a known session + object metadata.
    ///
    /// `meta` is normally reconstructed from the first frame's totals; see
    /// [`ReceiverSession::from_first_frame`].
    pub fn new(session_id: SessionIdRaw, meta: ObjectMeta) -> Self {
        let symbol_size = meta.symbol_size;
        let total_blocks = meta.blocks.len() as u32;
        let total_symbols = meta.blocks.iter().map(|b| b.num_source_symbols).sum();
        let decoder = Decoder::new(meta.clone());
        let received = meta.blocks.iter().map(|_| HashSet::new()).collect();
        let progress = Progress {
            total_symbols,
            total_blocks,
            ..Progress::default()
        };
        Self {
            session_id,
            symbol_size,
            total_blocks,
            total_symbols,
            decoder,
            meta,
            meta_confirmed: false,
            file_meta: crate::descriptor::FileMeta::default(),
            received,
            symbol_cache: HashMap::new(),
            progress,
        }
    }

    /// Create a receiver with **confirmed** (authoritative) metadata — data
    /// frames will be decoded immediately instead of buffered. Used when the
    /// caller already has the real OTI (e.g. from a descriptor).
    pub fn new_confirmed(session_id: SessionIdRaw, meta: ObjectMeta) -> Self {
        let mut rx = Self::new(session_id, meta);
        rx.meta_confirmed = true;
        rx
    }

    /// Reconstruct minimal object metadata from a frame header, sufficient to
    /// build a decoder.
    ///
    /// NOTE: the per-block symbol counts cannot be perfectly derived from the
    /// aggregate totals alone; we assume a single source block when totals are
    /// small, otherwise an even split. The *authoritative* per-block layout
    /// comes from the OTI embedded in a session descriptor. For the optical
    /// channel we additionally broadcast an OTI-bearing "descriptor frame" —
    /// but to keep v1 simple and robust, the sender emits all source symbols
    /// for every block in order, and the receiver here uses the OTI it
    /// reconstructs once it has seen symbols from all blocks.
    ///
    /// In practice this constructor is used after the receiver learns the OTI
    /// (e.g. from a handshake / first source symbols). See tests for usage.
    pub fn from_first_frame(frame: &Frame) -> Self {
        let mut rx = Self::new(
            frame.header.session_id,
            derive_meta_from_totals(
                frame.header.total_blocks,
                frame.header.total_symbols,
                frame.header.symbol_size,
            ),
        );
        // Heuristic meta — NOT confirmed; data frames buffered until descriptor.
        rx.meta_confirmed = false;
        rx
    }

    pub fn session_id(&self) -> SessionIdRaw {
        self.session_id
    }
    pub fn total_symbols(&self) -> u32 {
        self.total_symbols
    }
    pub fn is_complete(&self) -> bool {
        self.decoder.is_complete()
    }

    /// File metadata learned from descriptor frames (filename, size, CRC32).
    pub fn file_meta(&self) -> &crate::descriptor::FileMeta {
        &self.file_meta
    }

    /// True once the authoritative OTI has been received via a descriptor frame.
    /// Before this, data frames are only buffered (not decoded).
    pub fn is_meta_confirmed(&self) -> bool {
        self.meta_confirmed
    }

    /// Ingest a frame.
    ///
    /// - Descriptor frames (`FLAG_DESCRIPTOR`) update the session's object
    ///   metadata from the authoritative OTI carried in the payload, rebuilding
    ///   the decoder while preserving all already-received symbols.
    /// - Data frames are deduplicated and fed to the RaptorQ decoder.
    pub fn ingest(&mut self, frame: Frame) -> Result<bool> {
        if frame.header.session_id != self.session_id {
            return Err(Error::SessionMismatch {
                expected: self.session_id,
                got: frame.header.session_id,
            });
        }
        self.progress.frames_seen += 1;

        // Descriptor frame: adopt authoritative metadata + file meta.
        if frame.header.flags & qr_protocol::frame::FLAG_DESCRIPTOR != 0 {
            if let Some(info) = crate::descriptor::parse_payload(&frame.payload) {
                if !self.meta_confirmed || info.meta != self.meta {
                    self.apply_meta(info.meta.clone());
                }
                self.meta_confirmed = true;
                // Always update file metadata.
                self.file_meta = info.file_meta;
            }
            return Ok(self.is_complete());
        }

        // Buffer data frames until we have the authoritative OTI (from a
        // descriptor). The heuristic layout from `derive_meta_from_totals` is
        // wrong for multi-block files, so feeding symbols into the wrong
        // decoder would corrupt progress. Once the descriptor arrives, all
        // cached symbols are replayed into the correct decoder.
        if !self.meta_confirmed {
            self.symbol_cache.insert((frame.header.sbn, frame.header.esi), frame.payload);
            // Update approximate progress from cache size.
            self.progress.received_symbols = self.symbol_cache.len() as u32;
            self.progress.decoded_symbols = 0;
            // Show "waiting for descriptor" status.
            return Ok(false);
        }

        let sbn = frame.header.sbn as usize;
        if sbn >= self.received.len() {
            // Block out of range — ignore but count as corrupt.
            self.progress.frames_corrupt += 1;
            return Ok(self.is_complete());
        }
        let esi = frame.header.esi;
        if !self.received[sbn].insert(esi) {
            self.progress.frames_duplicate += 1;
            return Ok(self.is_complete());
        }
        self.progress.received_symbols += 1;

        // Cache the symbol data for potential replay if metadata changes.
        self.symbol_cache.insert((sbn as u32, esi), frame.payload.clone());

        let symbol = Symbol::new(sbn as u32, esi, frame.payload);
        let _ = self.decoder.add_symbol(&symbol)?;

        // Refresh decoded-symbol / decoded-block counts.
        self.refresh_decoded_counts();
        Ok(self.is_complete())
    }

    /// Replace object metadata + decoder, replaying every stored symbol so no
    /// progress is lost when the authoritative layout arrives late.
    fn apply_meta(&mut self, meta: ObjectMeta) {
        // Save the cached symbols before we reset state.
        let cached_symbols = std::mem::take(&mut self.symbol_cache);

        // Update metadata and rebuild decoder.
        self.meta = meta.clone();
        self.symbol_size = meta.symbol_size;
        self.total_blocks = meta.blocks.len() as u32;
        self.total_symbols = meta.blocks.iter().map(|b| b.num_source_symbols).sum();
        self.received = meta.blocks.iter().map(|_| HashSet::new()).collect();
        self.decoder = Decoder::new(meta);
        self.progress.total_symbols = self.total_symbols;
        self.progress.total_blocks = self.total_blocks;

        // Replay all cached symbols into the new decoder.
        for ((sbn, esi), data) in cached_symbols {
            // Validate the symbol still fits in the new layout.
            if (sbn as usize) < self.received.len() {
                // Re-insert into received set and decoder.
                if self.received[sbn as usize].insert(esi) {
                    let symbol = Symbol::new(sbn, esi, data.clone());
                    // Ignore errors during replay; the symbol might not fit the new layout.
                    let _ = self.decoder.add_symbol(&symbol);
                    // Re-cache for potential future metadata updates.
                    self.symbol_cache.insert((sbn, esi), data);
                }
            }
        }

        // Refresh progress counters after replay.
        self.refresh_decoded_counts();
    }

    fn refresh_decoded_counts(&mut self) {
        let mut decoded_symbols = 0u32;
        let mut decoded_blocks = 0u32;
        for (i, b) in self.meta.blocks.iter().enumerate() {
            if self.decoder.block_progress(b.sbn).is_some() {
                decoded_symbols += b.num_source_symbols;
                decoded_blocks += 1;
            } else {
                // Approximate: count unique source symbols received for this block.
                let k = b.num_source_symbols;
                let got = self.received[i]
                    .iter()
                    .filter(|&&esi| esi < k)
                    .count() as u32;
                decoded_symbols += got.min(k);
            }
        }
        self.progress.decoded_symbols = decoded_symbols;
        self.progress.decoded_blocks = decoded_blocks;
    }

    /// Reassemble the original object once complete.
    pub fn assemble(&self) -> Option<Vec<u8>> {
        self.decoder.assemble()
    }

    pub fn progress(&self) -> Progress {
        let mut progress = self.progress.clone();
        progress.meta_confirmed = self.meta_confirmed;
        progress
    }

    /// Snapshot progress (clone).
    pub fn progress_snapshot(&self) -> Progress {
        self.progress()
    }
}

/// Derive a single-block `ObjectMeta` from totals (used before the receiver
/// knows the real per-block layout). The decoder built from this works
/// correctly only when the object fits in one source block; for multi-block
/// objects the caller should supply the real OTI.
///
/// WARNING: This is a heuristic approximation. The actual RaptorQ block
/// partitioning may differ from this even split. This metadata should ONLY
/// be used temporarily until the authoritative descriptor frame arrives.
/// The receiver will rebuild the decoder with correct metadata when it receives
/// a descriptor frame (FLAG_DESCRIPTOR), at which point cached symbols are replayed.
pub fn derive_meta_from_totals(total_blocks: u32, total_symbols: u32, symbol_size: u32) -> ObjectMeta {
    use raptorq::ObjectTransmissionInformation;
    // Heuristic: place all symbols in the number of blocks reported, splitting
    // as evenly as possible. The OTI we hand raptorq must satisfy its internal
    // constraints; we use source_blocks = max(1, total_blocks).
    let nblocks = total_blocks.max(1) as u8;
    let oti = ObjectTransmissionInformation::with_defaults(
        total_symbols as u64 * symbol_size as u64,
        symbol_size as u16 + 4,
    );
    // The OTI's internal block count is determined by the library and may not
    // match our requested nblocks. We serialize it for the wire format.
    let raw = oti.serialize();
    // Even split: divide total_symbols across nblocks as evenly as possible.
    let per = total_symbols / nblocks as u32;
    let rem = total_symbols % nblocks as u32;
    let blocks: Vec<raptorq_core::SourceBlockMeta> = (0..nblocks as u32)
        .map(|i| raptorq_core::SourceBlockMeta {
            sbn: i,
            num_source_symbols: if i < rem { per + 1 } else { per },
            block_length: (if i < rem { per + 1 } else { per }) as u64 * symbol_size as u64,
        })
        .collect();
    let total_len = total_symbols as u64 * symbol_size as u64;
    ObjectMeta {
        transfer_length: total_len,
        symbol_size,
        oti_bytes: raw,
        blocks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sender::{SenderConfig, SenderSession};
    use qr_protocol::SessionId;
    use raptorq_core::Config;

    fn payload(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i & 0xff) as u8).collect()
    }

    fn run_roundtrip(data: &[u8], redundancy: u8, drop_every: u32) {
        let sid = SessionId::derive("file", data.len() as u64, 0, &[]);
        let mut sender = SenderSession::new(
            data,
            sid,
            SenderConfig {
                codec: Config::default(),
                redundancy_pct: redundancy,
            },
            crate::descriptor::FileMeta::default(),
        )
        .unwrap();
        let meta = sender.meta().clone();

        let mut rx = ReceiverSession::new_confirmed(sid.into(), meta);
        let total = sender.total_k();
        // Emit enough frames: one full source pass + a few repair rounds.
        let frames_needed = (total as u32 + total as u32 * redundancy as u32 / 100 + 10) as usize;
        let mut emitted = 0u32;
        let mut ingested = 0u32;
        for _ in 0..(frames_needed * 3) {
            if rx.is_complete() {
                break;
            }
            let frame = sender.next_frame().unwrap();
            emitted += 1;
            if emitted % drop_every == 0 {
                continue; // simulate frame loss
            }
            // Re-serialize/parse to exercise the wire path.
            let bytes = frame.to_bytes();
            let parsed = Frame::from_bytes(&bytes).unwrap();
            rx.ingest(parsed).unwrap();
            ingested += 1;
        }
        assert!(
            rx.is_complete(),
            "failed to recover: emitted={emitted} ingested={ingested} total_k={total}"
        );
        let out = rx.assemble().unwrap();
        // The assembled bytes are the symbol-padded payload; the original data
        // occupies the first `data.len()` bytes (trailing bytes are zero pad).
        // In the real pipeline, the payload is a zstd stream whose own length
        // is self-describing, so truncation to the true length happens at
        // decompression time.
        assert!(out.len() >= data.len(), "assembled too short");
        assert_eq!(&out[..data.len()], data, "payload bytes must match");
        // Padding region must be all zero.
        assert!(
            out[data.len()..].iter().all(|&b| b == 0),
            "trailing pad must be zero"
        );
    }

    #[test]
    fn roundtrip_small_nodrop() {
        let data = payload(50_000);
        run_roundtrip(&data, 10, 1000); // drop_every huge → no drops
    }

    #[test]
    fn roundtrip_with_20pct_loss() {
        // Drop ~1 in 5 frames to simulate ~20% loss; 50% repair redundancy
        // should still allow recovery.
        let data = payload(30_000);
        run_roundtrip(&data, 50, 5);
    }
}
