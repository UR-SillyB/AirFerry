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
            // 25% redundancy is a better all-round default than 10% under real
            // camera-scan conditions, where the receiver commonly reports
            // 30–50% frame loss. RaptorQ only needs K unique symbols to decode
            // a block, and at 40% loss the receiver keeps ~60% of each pass —
            // so a single pass yields ~0.6×(1+R/100)×K usable symbols. A low
            // 10% redundancy means almost no slack (0.66×K), forcing two full
            // passes to recover. 25% gives headroom for bursty loss without
            // crossing into diminishing-returns territory (>50%).
            redundancy_pct: 25,
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
    /// Whether `start_ms` has been set. Kept separate from `start_ms` so a
    /// wall-clock of 0 (impossible in practice but defensive) is handled.
    started: bool,
    /// Timestamp of the first emitted frame; 0 until `started` becomes true.
    /// Delayed so that the cumulative-average FPS (frames / elapsed) is not
    /// diluted by the WASM init gap between `new()` and the first render tick.
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
            // Descriptor every ~16 frames (~0.5s at 30fps). Each descriptor is a
            // full frame that carries no source data, so it is pure overhead:
            // the old value of 5 wasted ~20% of the channel on metadata at
            // exactly the time (high frame loss) when every data frame counts.
            // A receiver needs just *one* descriptor to join, and the fountain
            // stream loops forever, so 0.5s is still a fast rejoin cadence
            // while reclaiming ~15% of the wire for real symbols.
            descriptor_interval: 16,
            started: false,
            start_ms: 0,            // Set on first next_frame() call
            stats: Stats::default(),
        })
    }

    /// How often (in frames) a descriptor frame is emitted. Default 5.
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
    /// A *descriptor frame* is emitted every `descriptor_interval` emitted
    /// frames of any kind (default 5), carrying the authoritative object
    /// metadata so late-joining receivers can build a decoder. The very first
    /// emitted frame is always a descriptor so an immediate-join receiver can
    /// build its decoder without having to cache symbols.
    ///
    /// Note: the cadence is measured in *all* emitted frames (descriptors
    /// included), so the effective ratio is ~1 descriptor per
    /// `descriptor_interval` frames on the wire.
    pub fn next_frame(&mut self) -> Result<Frame> {
        if self.plan.is_empty() {
            return Err(Error::NoPayload);
        }

        // Start the clock on the very first frame so that the cumulative FPS
        // isn't diluted by the initialisation delay between new() and the
        // first render-loop tick.
        if !self.started {
            self.start_ms = now_ms();
            self.started = true;
        }

        let now_ms_val = now_ms();

        // Emit a descriptor every `descriptor_interval` frames (counted in
        // emitted frames of any kind, so the cadence stays regular). The very
        // first emitted frame is always a descriptor so a receiver that joins
        // immediately can build its decoder without having to cache symbols.
        let interval = self.descriptor_interval.max(1) as u64;
        if self.frame_index == 0 || (self.frame_index > 0 && self.frame_index % interval == 0) {
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
        if self.started {
            s.elapsed_ms = now_ms().saturating_sub(self.start_ms);
        }
        s.finalize();
        s
    }
}

/// Build the ordered (sbn, esi) list for one full pass.
///
/// Strategy: emit source symbols **round-robin across blocks** (esi 0 of every
/// block, then esi 1 of every block, …), then emit repair symbols the same way.
/// Round-robin interleaving is more robust to bursty loss: at 40% loss the
/// receiver tends to drop runs of consecutive frames, and the old block-major
/// order meant a single burst could wipe a whole swath of one block's symbols
/// while other blocks were already complete — leaving that block stranded until
/// the next full pass. With round-robin, every burst is spread thinly across
/// all blocks, so each block advances roughly in lockstep and hits its decode
/// threshold together.
fn build_emission_plan(meta: &ObjectMeta, total_k: u32, redundancy_pct: u8) -> Vec<(u32, u32)> {
    let mut plan: Vec<(u32, u32)> = Vec::with_capacity(total_k as usize);
    // 1. Source symbols, round-robin across blocks (esi-major, not block-major).
    //    For each esi index, emit (sbn, esi) for every block that has that esi.
    let max_k = meta
        .blocks
        .iter()
        .map(|b| b.num_source_symbols)
        .max()
        .unwrap_or(0);
    for esi in 0..max_k {
        for b in &meta.blocks {
            if esi < b.num_source_symbols {
                plan.push((b.sbn, esi));
            }
        }
    }
    // 2. Repair symbols, round-robin across blocks (same rationale).
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
            compression: qr_protocol::compress::COMPRESSION_NONE,
            compressed_size: 0,
            compressed_size_known: true,
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

    /// Source symbols must be interleaved round-robin across blocks (esi-major
    /// order), not emitted block-major. This is the burst-loss optimisation:
    /// with the old block-major order a single burst of dropped frames could
    /// starve one block while others were already complete. Round-robin spreads
    /// each burst thinly so every block advances together.
    #[test]
    fn source_symbols_interleaved_across_blocks() {
        use raptorq_core::{ObjectMeta, SourceBlockMeta};
        // Hand-build a 3-block object so the test does not depend on the
        // raptorq library's (length-dependent) block-partitioning heuristic,
        // which only produces multiple blocks for very large payloads.
        let meta = ObjectMeta {
            transfer_length: 3 * 10 * 1024,
            symbol_size: 1024,
            oti_bytes: [0u8; 12],
            blocks: vec![
                SourceBlockMeta { sbn: 0, num_source_symbols: 10, block_length: 10 * 1024 },
                SourceBlockMeta { sbn: 1, num_source_symbols: 10, block_length: 10 * 1024 },
                SourceBlockMeta { sbn: 2, num_source_symbols: 10, block_length: 10 * 1024 },
            ],
        };
        let total_k = 30;
        let plan = build_emission_plan(&meta, total_k, 10);

        // Source-symbol portion of the plan (esi < K_block).
        let source_plan: Vec<(u32, u32)> = plan.into_iter()
            .filter(|(sbn, esi)| (*esi as usize) < meta.blocks[*sbn as usize].num_source_symbols as usize)
            .collect();

        // Round-robin: first 3 symbols must be esi=0 of each of the 3 blocks.
        let first_round = &source_plan[..3];
        let sbns: std::collections::HashSet<u32> = first_round.iter().map(|(sbn, _)| *sbn).collect();
        assert_eq!(sbns.len(), 3, "first round should cover all 3 blocks once, got {:?}", first_round);
        assert!(first_round.iter().all(|(_, esi)| *esi == 0), "first round should all be esi=0");

        // The old block-major order would emit sbn=0 ten times in a row.
        // Round-robin must NOT — consecutive entries must differ in sbn.
        let consecutive_same = first_round.windows(2).all(|w| w[0].0 == w[1].0);
        assert!(!consecutive_same, "plan is block-major, not interleaved: {:?}", first_round);
    }

    /// The default descriptor interval should be high enough that descriptors
    /// are a small fraction of the wire (each descriptor is pure overhead).
    #[test]
    fn default_descriptor_interval_is_efficient() {
        let data = payload(50_000);
        let s = SenderSession::new(&data, SessionId::zero(), SenderConfig::default(), test_file_meta()).unwrap();
        // <=20% of the wire for descriptors means interval >= 5; we default to
        // 16 (~6%), so this guards against accidentally dropping it back to the
        // old wasteful 5.
        assert!(s.descriptor_interval >= 16, "descriptor interval too low: {}", s.descriptor_interval);
    }
}
