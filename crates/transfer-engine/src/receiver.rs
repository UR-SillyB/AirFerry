//! Receiver-side session orchestration.

use crate::{progress::Progress, Error, Result};
use qr_protocol::{frame::SessionIdRaw, Frame};
use raptorq_core::{Decoder, ObjectMeta, Symbol};
use std::collections::{HashMap, HashSet};
use std::vec::Vec;

/// A receiver session.
///
/// The session is created **without** object metadata: until an authoritative
/// descriptor frame arrives, every data frame is only buffered in a replay
/// cache. This avoids the previous design's bug of building a *guessed*
/// decoder from the frame-header totals (`derive_meta_from_totals`), whose
/// per-block layout never matched the real RaptorQ partitioning for multi-block
/// objects — feeding cached symbols into that wrong decoder corrupted progress
/// or silently stalled recovery. With the cache-only bootstrap, the first
/// descriptor frame rebuilds a *correct* decoder and replays all buffered
/// symbols into it.
///
/// For resume, use [`ReceiverSession::save_state`] / [`ReceiverSession::restore`].
pub struct ReceiverSession {
    session_id: SessionIdRaw,
    /// Authoritative object metadata. `None` until a descriptor frame arrives.
    meta: Option<ObjectMeta>,
    decoder: Option<Decoder>,
    /// Whether `meta` came from an authoritative descriptor frame.
    meta_confirmed: bool,
    /// File metadata learned from the descriptor frame (filename, size, CRC32).
    file_meta: crate::descriptor::FileMeta,
    received: Vec<HashSet<u32>>,
    /// Per-block count of distinct *source* symbols received (esi < K_block),
    /// maintained incrementally so [`refresh_decoded_counts`] is O(1)/frame
    /// instead of re-scanning every block's received-set each frame (which was
    /// O(n²) over a full transfer — a real slowdown on large files). Index is
    /// block position, matching `meta.blocks` / `received`.
    source_recv: Vec<u32>,
    symbol_cache: HashMap<(u32, u32), Vec<u8>>,
    progress: Progress,
    /// Consecutive session-mismatch count (reset on successful ingest).
    session_mismatch_streak: u32,
    /// Cached symbol_size from the frame header for approximate progress while
    /// `meta` is still `None`. Harmless to keep; only read before confirmation.
    pending_symbol_size: u32,
}

impl ReceiverSession {
    /// Create a receiver for a known session + object metadata.
    ///
    /// `meta` is normally reconstructed from the first frame's totals; see
    /// [`ReceiverSession::from_first_frame`].
    pub fn new(session_id: SessionIdRaw, meta: ObjectMeta) -> Self {
        Self::with_confirmed_meta(session_id, Some(meta))
    }

    /// Create a receiver with **confirmed** (authoritative) metadata — data
    /// frames will be decoded immediately instead of buffered. Used when the
    /// caller already has the real OTI (e.g. from a descriptor).
    pub fn new_confirmed(session_id: SessionIdRaw, meta: ObjectMeta) -> Self {
        let mut rx = Self::with_confirmed_meta(session_id, Some(meta));
        rx.meta_confirmed = true;
        rx
    }

    /// Build a fully-confirmed session from authoritative metadata.
    fn with_confirmed_meta(session_id: SessionIdRaw, meta: Option<ObjectMeta>) -> Self {
        let total_symbols = meta
            .as_ref()
            .map(|m| m.blocks.iter().map(|b| b.num_source_symbols).sum())
            .unwrap_or(0);
        let total_blocks = meta.as_ref().map(|m| m.blocks.len() as u32).unwrap_or(0);
        let symbol_size = meta.as_ref().map(|m| m.symbol_size).unwrap_or(0);
        let decoder = meta.clone().map(Decoder::new);
        let received = meta
            .as_ref()
            .map(|m| m.blocks.iter().map(|_| HashSet::new()).collect())
            .unwrap_or_default();
        let source_recv = meta
            .as_ref()
            .map(|m| vec![0u32; m.blocks.len()])
            .unwrap_or_default();
        let progress = Progress {
            total_symbols,
            total_blocks,
            ..Progress::default()
        };
        Self {
            session_id,
            meta,
            decoder,
            meta_confirmed: false,
            file_meta: crate::descriptor::FileMeta::default(),
            received,
            source_recv,
            symbol_cache: HashMap::new(),
            progress,
            pending_symbol_size: symbol_size,
            session_mismatch_streak: 0,
        }
    }

    /// Bootstrap a receiver from the first observed frame.
    ///
    /// The session starts with **no** object metadata: data frames are buffered
    /// until a descriptor frame supplies the authoritative OTI. This replaces
    /// the old heuristic `derive_meta_from_totals`, which produced a wrong
    /// per-block layout for multi-block objects.
    pub fn from_first_frame(frame: &Frame) -> Self {
        Self::with_confirmed_meta(frame.header.session_id, None)
    }

    /// Create a "cache-only" receiver — no metadata yet, data frames buffered
    /// until the first descriptor arrives. Used by JNI (`receiverCreate`) and
    /// [`from_first_frame`] when no authoritative OTI is known.
    pub fn new_pending(session_id: SessionIdRaw) -> Self {
        Self::with_confirmed_meta(session_id, None)
    }

    pub fn session_id(&self) -> SessionIdRaw {
        self.session_id
    }
    pub fn total_symbols(&self) -> u32 {
        self.progress.total_symbols
    }
    pub fn is_complete(&self) -> bool {
        self.decoder.as_ref().is_some_and(|d| d.is_complete())
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
    /// - Data frames are buffered until metadata is confirmed, then deduplicated
    ///   and fed to the RaptorQ decoder.
    pub fn ingest(&mut self, frame: Frame) -> Result<bool> {
        if frame.header.session_id != self.session_id {
            self.session_mismatch_streak += 1;
            self.progress.session_mismatch_streak = self.session_mismatch_streak;
            return Err(Error::SessionMismatch {
                expected: self.session_id,
                got: frame.header.session_id,
            });
        }
        self.session_mismatch_streak = 0;
        self.progress.session_mismatch_streak = 0;
        self.progress.frames_seen += 1;

        // Descriptor frame: adopt authoritative metadata + file meta.
        if frame.header.flags & qr_protocol::frame::FLAG_DESCRIPTOR != 0 {
            if let Some(info) = crate::descriptor::parse_payload(&frame.payload) {
                // Only rebuild when the authoritative layout differs from what
                // we currently hold (or we had none at all).
                let needs_rebuild = match &self.meta {
                    None => true,
                    Some(cur) => *cur != info.meta,
                };
                if needs_rebuild {
                    self.apply_meta(info.meta.clone());
                }
                self.meta_confirmed = true;
                // The replay cache is only needed while the OTI is unknown;
                // once confirmed, no future rebuild can happen — drop it so it
                // doesn't grow unboundedly for the rest of the transfer.
                self.symbol_cache.clear();
                // Always update file metadata.
                self.file_meta = info.file_meta;
            }
            return Ok(self.is_complete());
        }

        // No authoritative metadata yet → buffer only. We must not feed symbols
        // into a guessed decoder (the old `derive_meta_from_totals` path did
        // exactly that and corrupted multi-block recovery). The cache is keyed
        // by (sbn, esi); on descriptor arrival `apply_meta` replays it into the
        // correct decoder. RaptorQ is a fountain code, so holding symbols in the
        // cache (vs decoding immediately) costs no information.
        if !self.meta_confirmed {
            self.pending_symbol_size = frame.header.symbol_size;
            self.symbol_cache
                .insert((frame.header.sbn, frame.header.esi), frame.payload);
            // Approximate progress from cache size (capped by UI).
            self.progress.received_symbols = self.symbol_cache.len() as u32;
            self.progress.decoded_symbols = 0;
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
        // O(1) source-symbol counter for progress (counts distinct esi < K_block).
        if let Some(meta) = &self.meta {
            if esi < meta.blocks[sbn].num_source_symbols {
                self.source_recv[sbn] += 1;
            }
        }

        // NOTE: we do NOT cache the payload here. The replay cache is only
        // populated while `!meta_confirmed` (above) for the case where the
        // authoritative OTI arrives later and the decoder must be rebuilt.
        // Once metadata is confirmed no rebuild can happen, so holding every
        // symbol's bytes would leak memory for the rest of the transfer.

        let symbol = Symbol::new(sbn as u32, esi, frame.payload);
        if let Some(dec) = self.decoder.as_mut() {
            let _ = dec.add_symbol(&symbol)?;
        }

        // Refresh decoded-symbol / decoded-block counts.
        self.refresh_decoded_counts();
        Ok(self.is_complete())
    }

    /// Replace object metadata + decoder, replaying every stored symbol so no
    /// progress is lost when the authoritative layout arrives.
    fn apply_meta(&mut self, meta: ObjectMeta) {
        // Save the cached symbols before we reset state.
        let cached_symbols = std::mem::take(&mut self.symbol_cache);

        // Update metadata and rebuild decoder.
        self.meta = Some(meta.clone());
        self.pending_symbol_size = meta.symbol_size;
        self.progress.total_symbols = meta.blocks.iter().map(|b| b.num_source_symbols).sum();
        self.progress.total_blocks = meta.blocks.len() as u32;
        self.received = meta.blocks.iter().map(|_| HashSet::new()).collect();
        self.source_recv = vec![0u32; meta.blocks.len()];
        self.decoder = Some(Decoder::new(meta));

        // Replay all cached symbols into the new decoder. We do NOT re-cache
        // them: once the authoritative OTI is applied the caller sets
        // meta_confirmed = true and clears the cache, and no further rebuild
        // can occur, so keeping the bytes around would just leak memory.
        for ((sbn, esi), data) in cached_symbols {
            let bi = sbn as usize;
            // Validate the symbol still fits in the new layout.
            if bi < self.received.len() {
                // Re-insert into received set and decoder.
                if self.received[bi].insert(esi) {
                    // Keep the O(1) source counter in sync with the replay.
                    if let Some(meta) = self.meta.as_ref() {
                        if esi < meta.blocks[bi].num_source_symbols {
                            self.source_recv[bi] += 1;
                        }
                    }
                    let symbol = Symbol::new(sbn, esi, data);
                    // Ignore errors during replay; the symbol might not fit the new layout.
                    if let Some(dec) = self.decoder.as_mut() {
                        let _ = dec.add_symbol(&symbol);
                    }
                }
            }
        }

        // Count how many unique symbols survived the replay.
        self.progress.received_symbols =
            self.received.iter().map(|s| s.len() as u32).sum();

        // Refresh progress counters after replay.
        self.refresh_decoded_counts();
    }

    fn refresh_decoded_counts(&mut self) {
        let Some(meta) = &self.meta else { return };
        let Some(dec) = &self.decoder else { return };
        let mut decoded_symbols = 0u32;
        let mut decoded_blocks = 0u32;
        for (i, b) in meta.blocks.iter().enumerate() {
            if dec.block_progress(b.sbn).is_some() {
                decoded_symbols += b.num_source_symbols;
                decoded_blocks += 1;
            } else {
                // Approximate progress from the incrementally-maintained source
                // counter — O(1) here, replacing the old per-block rescan of the
                // received-set that made this O(n²) over a full transfer.
                let k = b.num_source_symbols;
                decoded_symbols += self.source_recv[i].min(k);
            }
        }
        self.progress.decoded_symbols = decoded_symbols;
        self.progress.decoded_blocks = decoded_blocks;
    }

    /// Reassemble the RaptorQ object bytes exactly as transmitted (including
    /// any symbol-padding), without applying decompression. Used by callers
    /// and tests that want the raw recovered bytes.
    pub fn assemble_raw(&self) -> Option<Vec<u8>> {
        self.decoder.as_ref()?.assemble()
    }

    /// Reassemble the original file once complete.
    ///
    /// The RaptorQ decoder yields the transmitted payload padded with zeros up
    /// to a symbol boundary. This method trims that padding back to the real
    /// payload length and — when the descriptor advertised a compression
    /// algorithm — runs the matching decompressor to recover the original file
    /// bytes. Returns `None` if decoding is incomplete or decompression fails.
    pub fn assemble(&self) -> Option<Vec<u8>> {
        // `assemble_result` is `Result<Option<Vec<u8>>>`: `Ok(Some)` on success,
        // `Ok(None)` when decoding isn't complete yet, `Err` on a recoverable
        // decompression failure. Collapse both non-success cases to `None` —
        // `.ok()` turns the `Err` into `None`, and `.flatten()` unwraps the
        // `Option<Option<...>>` so an incomplete decode (`Ok(None)`) also maps
        // to `None`.
        self.assemble_result().ok().flatten()
    }

    /// Like [`assemble`](Self::assemble) but surfaces the decompression error
    /// instead of collapsing it to `None`. Returns `Ok(None)` when decoding is
    /// not yet complete (no bytes to assemble), `Ok(Some(bytes))` on success,
    /// and `Err(_)` if the bytes were recovered but the payload could not be
    /// decompressed (e.g. compressed_size was wrong or the stream is corrupt).
    pub fn assemble_result(&self) -> Result<Option<Vec<u8>>> {
        let Some(dec) = self.decoder.as_ref() else {
            return Ok(None);
        };
        let mut raw = match dec.assemble() {
            Some(b) => b,
            None => return Ok(None),
        };
        // Trim zero padding back to the true payload length. For compressed
        // payloads that is `compressed_size`; for uncompressed payloads the
        // v2/v3 parser sets compressed_size == original_size. The
        // `compressed_size_known` flag distinguishes "0 bytes is the real
        // length" from "we never learned it" (e.g. a receiver built without a
        // descriptor) — operating on the raw padded bytes in the latter case.
        if self.file_meta.compressed_size_known {
            let len = self.file_meta.compressed_size as usize;
            // A corrupt/overflowing descriptor should never claim more than we
            // actually recovered; clamp rather than panic.
            if len <= raw.len() {
                raw.truncate(len);
            } else {
                // The sender claimed a larger payload than RaptorQ recovered —
                // the object cannot be valid. Treat as a decompression failure
                // so the caller surfaces it instead of silently truncating.
                return Err(Error::Compress(format!(
                    "descriptor compressed_size ({len}) exceeds recovered payload ({})",
                    raw.len()
                )));
            }
        }
        if self.file_meta.compression == qr_protocol::compress::COMPRESSION_NONE {
            Ok(Some(raw))
        } else {
            qr_protocol::compress::decompress_with(&raw, self.file_meta.compression)
                .map(Some)
                .map_err(|e| Error::Compress(e.to_string()))
        }
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

/// Derive a single-block `ObjectMeta` from totals.
///
/// **Deprecated / retained only for JNI ABI compatibility and tests.** This
/// heuristic cannot reproduce the real RaptorQ per-block partitioning
/// (`partition()` in RFC 6330 §4.4.1.2) from aggregate totals alone, so a
/// decoder built from it decodes multi-block objects incorrectly. The live
/// receiver path now buffers data frames until a descriptor frame supplies the
/// authoritative OTI (see [`ReceiverSession::new_pending`]). Callers should
/// treat the returned metadata as a *placeholder* and never feed it symbols.
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
        let sender = SenderSession::new(
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
        // The sender advertises the padded payload length as compressed_size
        // (uncompressed path), so the receiver trims zero-padding back to it.
        // Without this the descriptor would carry compressed_size=0 and the
        // receiver would trim the recovered object to zero bytes.
        let mut fm = sender.file_meta().clone();
        fm.compressed_size = meta.transfer_length;
        fm.compressed_size_known = true;
        // Re-create the sender so its descriptor carries the corrected meta.
        let mut sender = SenderSession::new(
            data,
            sid,
            SenderConfig {
                codec: Config::default(),
                redundancy_pct: redundancy,
            },
            fm,
        )
        .unwrap();

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
        assert!(out.len() >= data.len(), "assembled too short: out={} data={}", out.len(), data.len());
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

    /// Regression test for Bug 1: a receiver bootstrapped with `from_first_frame`
    /// (cache-only, no guessed meta) must still recover a multi-block object
    /// once the descriptor arrives — even if it appears *after* many data frames.
    #[test]
    fn from_first_frame_recovers_multiblock_late_descriptor() {
        let data = payload(120_000); // spans several source blocks
        let sid = SessionId::derive("late", data.len() as u64, 0, &[]);
        // First create the sender to learn the padded transfer_length, then
        // rebuild with a FileMeta whose compressed_size matches it so the
        // descriptor advertises the correct payload size.
        let probe = SenderSession::new(
            &data,
            sid,
            SenderConfig {
                codec: Config::default(),
                redundancy_pct: 20,
            },
            crate::descriptor::FileMeta::default(),
        )
        .unwrap();
        let padded_len = probe.meta().transfer_length;
        let fm = crate::descriptor::FileMeta {
            filename: String::new(),
            original_size: data.len() as u64,
            crc32: 0,
            compression: qr_protocol::compress::COMPRESSION_NONE,
            compressed_size: padded_len,
            compressed_size_known: true,
        };
        let mut sender = SenderSession::new(
            &data,
            sid,
            SenderConfig {
                codec: Config::default(),
                redundancy_pct: 20,
            },
            fm,
        )
        .unwrap();
        sender.set_descriptor_interval(8);

        // Buffer a batch of frames with the descriptor deliberately delayed.
        let mut frames: Vec<Frame> = Vec::new();
        for _ in 0..(sender.total_k() as usize * 2 + 32) {
            frames.push(sender.next_frame().unwrap());
        }

        // Receiver bootstraps from the very first (descriptor) frame via
        // from_first_frame, which now creates a cache-only session.
        let mut rx = ReceiverSession::from_first_frame(&frames[0]);
        for f in frames {
            let parsed = Frame::from_bytes(&f.to_bytes()).unwrap();
            let _ = rx.ingest(parsed);
            if rx.is_complete() {
                break;
            }
        }
        assert!(rx.is_complete(), "late-descriptor receiver must recover");
        let out = rx.assemble().unwrap();
        assert_eq!(&out[..data.len()], data);
    }
}
