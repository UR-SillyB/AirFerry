//! Sender-side session orchestration.

use crate::descriptor::FileMeta;
use crate::{progress::Stats, Error, Result};
use crate::time::now_ms;
use qr_protocol::{chunker, frame::SessionIdRaw, Frame, SessionId};
use raptorq_core::{Config, Encoder, ObjectMeta, Symbol};
use std::vec::Vec;

/// Configuration for a sender session.
#[derive(Debug, Clone, Copy)]
pub struct SenderConfig {
    /// Codec configuration (symbol size).
    pub codec: Config,
    /// Redundancy ratio in percent (5..=50). Each full pass emits the K source
    /// symbols plus K*redundancy/100 repair symbols, then loops.
    pub redundancy_pct: u8,
}

impl Default for SenderConfig {
    fn default() -> Self {
        Self {
            codec: Config::default(),
            redundancy_pct: 10,
        }
    }
}

impl SenderConfig {
    pub fn validate(&self) -> Result<()> {
        // The protocol specification allows 5..=50% redundancy for optimal
        // performance. Values outside this range may work but are not recommended:
        // - Too low (<5%): insufficient error correction for lossy channels
        // - Too high (>50%): diminishing returns, wastes bandwidth
        if !(5..=50).contains(&self.redundancy_pct) {
            return Err(Error::InvalidRedundancy(self.redundancy_pct));
        }
        Ok(())
    }
}

/// A sender session.
///
/// Holds the (already Zstd-compressed) payload and a RaptorQ encoder over it,
/// plus a deterministic session id. Call [`SenderSession::next_frame`] in a
/// render loop to drive the QR video stream; it loops forever across passes,
/// so a receiver can rejoin at any point.
pub struct SenderSession {
    config: SenderConfig,
    session_id: SessionIdRaw,
    encoder: Encoder,
    meta: ObjectMeta,
    file_meta: FileMeta,
    /// Total source symbols K across all blocks.
    total_k: u32,
    plan: Vec<(u32, u32)>,
    cursor: usize,
    frame_index: u64,
    descriptor_interval: u32,
    start_ms: u64,
    stats: Stats,
}

impl SenderSession {
    /// Create a session from payload bytes + file metadata.
    pub fn new(
        compressed_payload: &[u8],
        session_id: SessionId,
        config: SenderConfig,
        file_meta: FileMeta,
    ) -> Result<Self> {
        config.validate()?;
        let padded = chunker::pad_to_symbols(compressed_payload, config.codec);
        let encoder = Encoder::new(&padded, config.codec)?;
        let meta = encoder.meta().clone();
        let total_k: u32 = meta.blocks.iter().map(|b| b.num_source_symbols).sum();

        let plan = build_emission_plan(&meta, total_k, config.redundancy_pct);

        Ok(Self {
            config,
            session_id: session_id.into(),
            encoder,
            meta,
            file_meta,
            total_k,
            plan,
            cursor: 0,
            frame_index: 0,
            descriptor_interval: 15,
            start_ms: now_ms(),
            stats: Stats::default(),
        })
    }

    /// How often (in frames) a descriptor frame is emitted. Default 30.
    pub fn set_descriptor_interval(&mut self, interval: u32) {
        self.descriptor_interval = interval.max(1);
    }

    /// Object metadata (transfer length, OTI, per-block K).
    pub fn meta(&self) -> &ObjectMeta {
        &self.meta
    }

    /// File metadata (filename, original size, CRC32).
    pub fn file_meta(&self) -> &FileMeta {
        &self.file_meta
    }

    pub fn session_id(&self) -> SessionIdRaw {
        self.session_id
    }

    pub fn total_k(&self) -> u32 {
        self.total_k
    }

    pub fn num_blocks(&self) -> usize {
        self.meta.blocks.len()
    }

    /// Emit the next frame, looping the emission plan forever.
    ///
    /// Every `descriptor_interval` data frames (default 30), a *descriptor
    /// frame* is emitted instead of a data symbol, carrying the authoritative
    /// object metadata so late-joining receivers can build a decoder.
    pub fn next_frame(&mut self) -> Result<Frame> {
        if self.plan.is_empty() {
            return Err(Error::NoPayload);
        }

        let now_ms_val = now_ms();

        // Emit a descriptor every `descriptor_interval` frames (counted in
        // emitted frames of any kind, so the cadence stays regular).
        let interval = self.descriptor_interval.max(1) as u64;
        if self.frame_index > 0 && self.frame_index % interval == 0 {
            self.frame_index = self.frame_index.wrapping_add(1);
            let frame = crate::descriptor::build_frame(&self.meta, &self.file_meta, self.session_id, self.frame_index, now_ms_val)?;
            self.stats.record_sent(frame.payload.len() as u64);
            return Ok(frame);
        }

        let (sbn, esi) = self.plan[self.cursor % self.plan.len()];
        self.cursor = self.cursor.wrapping_add(1);

        let symbol = self.fetch_symbol(sbn, esi)?;
        self.frame_index = self.frame_index.wrapping_add(1);

        self.stats.record_sent(symbol.data.len() as u64);

        Ok(Frame::build(
            self.session_id,
            0,
            sbn,
            esi,
            self.meta.blocks.len() as u32,
            self.total_k,
            self.config.codec.symbol_size,
            self.frame_index,
            now_ms_val,
            &symbol.data,
        ))
    }

    fn fetch_symbol(&self, sbn: u32, esi: u32) -> Result<Symbol> {
        let k = self.meta.blocks[sbn as usize].num_source_symbols;
        if esi < k {
            self.encoder.source_symbol(sbn, esi).map_err(Into::into)
        } else {
            // Repair symbol: esi offset within the repair namespace.
            let repair_offset = esi - k;
            let mut syms = self.encoder.repair_symbols(sbn, repair_offset, 1)?;
            Ok(syms.remove(0))
        }
    }

    /// Live statistics snapshot (sent frames, fps, throughput, elapsed).
    pub fn stats(&self) -> Stats {
        let mut s = self.stats.clone();
        let now = now_ms();
        s.elapsed_ms = now.saturating_sub(self.start_ms);
        s.finalize();
        s
    }
}

/// Build the ordered (sbn, esi) list for one full pass.
///
/// Strategy: walk blocks; for each block emit all K source symbols first
/// (they decode fastest), then emit the block's repair symbols. Interleaving
/// repair symbols *across* blocks is more robust to bursty loss of the last
/// blocks, so we interleave repair symbols block-round-robin at the tail.
fn build_emission_plan(meta: &ObjectMeta, total_k: u32, redundancy_pct: u8) -> Vec<(u32, u32)> {
    let mut plan: Vec<(u32, u32)> = Vec::with_capacity(total_k as usize);
    // 1. All source symbols, block by block.
    for b in &meta.blocks {
        for esi in 0..b.num_source_symbols {
            plan.push((b.sbn, esi));
        }
    }
    // 2. Repair symbols, round-robin across blocks.
    let per_block_repair = |k: u32| -> u32 {
        if k == 0 {
            0
        } else {
            // Calculate repair symbols based on redundancy percentage.
            // For 0% redundancy (if somehow passed validation), return 0 repair symbols.
            let repairs = k * redundancy_pct as u32 / 100;
            // Only force at least 1 repair symbol if redundancy > 0
            if redundancy_pct > 0 && repairs == 0 {
                1
            } else {
                repairs
            }
        }
    };
    let max_repair = meta
        .blocks
        .iter()
        .map(|b| per_block_repair(b.num_source_symbols))
        .max()
        .unwrap_or(0);
    for r in 0..max_repair {
        for b in &meta.blocks {
            let k = b.num_source_symbols;
            if r < per_block_repair(k) {
                plan.push((b.sbn, k + r));
            }
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i & 0xff) as u8).collect()
    }

    fn test_file_meta() -> FileMeta {
        FileMeta {
            filename: "test.bin".to_string(),
            original_size: 0,
            crc32: 0,
        }
    }

    #[test]
    fn produces_frames_in_sequence() {
        let data = payload(50_000);
        let mut s = SenderSession::new(&data, SessionId::derive("f", 50_000, 0, &[]), SenderConfig::default(), test_file_meta()).unwrap();
        let f0 = s.next_frame().unwrap();
        assert_eq!(f0.header.session_id, s.session_id());
        assert_eq!(f0.payload.len(), 1024);
        assert_eq!((f0.header.sbn, f0.header.esi), (0, 0));
        let f1 = s.next_frame().unwrap();
        assert_eq!(f1.header.frame_index, 2);
    }

    #[test]
    fn loops_plan_indefinitely() {
        let data = payload(2048);
        let mut s = SenderSession::new(&data, SessionId::zero(), SenderConfig::default(), test_file_meta()).unwrap();
        let plan_len = s.plan.len();
        for _ in 0..(plan_len * 3 + 5) {
            let _ = s.next_frame().unwrap();
        }
    }

    #[test]
    fn plan_includes_repair_symbols() {
        let data = payload(50_000);
        let s = SenderSession::new(&data, SessionId::zero(), SenderConfig { codec: Config::default(), redundancy_pct: 20 }, test_file_meta()).unwrap();
        let total_k = s.total_k();
        assert!(s.plan.len() as u32 > total_k);
        let repair_count = s.plan.iter().filter(|(sbn, esi)| {
            let k = s.meta.blocks[*sbn as usize].num_source_symbols;
            *esi >= k
        }).count();
        assert!(repair_count > 0);
    }
}
