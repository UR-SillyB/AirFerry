//! Progress and throughput statistics shared by sender & receiver.

use std::time::Duration;

/// Live throughput / count snapshot.
#[derive(Debug, Clone, Default)]
pub struct Stats {
    /// Total bytes (payload only) sent or received so far.
    pub bytes: u64,
    /// Number of frames sent or received.
    pub frames: u64,
    /// Elapsed wall-clock since session start (ms), filled on snapshot.
    pub elapsed_ms: u64,
}

impl Stats {
    pub fn record_sent(&mut self, payload_bytes: u64) {
        self.bytes += payload_bytes;
        self.frames += 1;
    }

    pub fn record_received(&mut self, payload_bytes: u64, unique: bool) {
        // Only count unique symbols toward byte totals (dedup).
        if unique {
            self.bytes += payload_bytes;
        }
        self.frames += 1;
    }

    /// Recompute derived fields (call before exposing).
    pub fn finalize(&mut self) {}

    /// Effective frames per second.
    pub fn fps(&self) -> f64 {
        if self.elapsed_ms == 0 {
            0.0
        } else {
            self.frames as f64 * 1000.0 / self.elapsed_ms as f64
        }
    }

    /// Effective payload throughput in bytes/sec.
    pub fn throughput_bps(&self) -> f64 {
        if self.elapsed_ms == 0 {
            0.0
        } else {
            self.bytes as f64 * 1000.0 / self.elapsed_ms as f64
        }
    }

    /// Estimated remaining time given `remaining_bytes` at current throughput.
    pub fn eta(&self, remaining_bytes: u64) -> Option<Duration> {
        let tput = self.throughput_bps();
        if tput <= 0.0 {
            return None;
        }
        Some(Duration::from_secs_f64(remaining_bytes as f64 / tput))
    }
}

/// Receiver-side recovery progress.
#[derive(Debug, Clone, Default)]
pub struct Progress {
    /// Source symbols decoded so far (sum across blocks).
    pub decoded_symbols: u32,
    /// Total source symbols K.
    pub total_symbols: u32,
    /// Unique symbols received (deduplicated) — may exceed decoded when a
    /// block has not yet hit its decode threshold.
    pub received_symbols: u32,
    /// Distinct frames received (including duplicates) for loss-rate stats.
    pub frames_seen: u64,
    /// Duplicate frames (same ESI received multiple times).
    pub frames_duplicate: u64,
    /// Frames that failed CRC and were discarded.
    pub frames_corrupt: u64,
    /// Number of blocks fully reconstructed.
    pub decoded_blocks: u32,
    /// Total blocks.
    pub total_blocks: u32,
    /// Whether metadata has been confirmed via descriptor frame.
    pub meta_confirmed: bool,
    /// Number of consecutive session-mismatch errors since the last accepted
    /// frame (reset to 0 when a frame is accepted).  Used by the JNI layer to
    /// signal the Kotlin side that the receiver was likely initialised from a
    /// corrupted first QR decode and should be re-created.
    pub session_mismatch_streak: u32,
}

impl Progress {
    /// Fraction (0.0..=1.0) of source symbols decoded.
    pub fn decoded_fraction(&self) -> f64 {
        if self.total_symbols == 0 {
            0.0
        } else {
            self.decoded_symbols as f64 / self.total_symbols as f64
        }
    }

    /// Frame loss ratio (corrupt + duplicate) over total seen.
    ///
    /// Note: frames_seen includes all frames (corrupt, duplicate, and good).
    /// This ratio represents the percentage of frames that were unusable.
    pub fn loss_ratio(&self) -> f64 {
        if self.frames_seen == 0 {
            0.0
        } else {
            (self.frames_duplicate + self.frames_corrupt) as f64 / self.frames_seen as f64
        }
    }

    pub fn is_complete(&self) -> bool {
        self.total_blocks > 0 && self.decoded_blocks == self.total_blocks
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fps_and_throughput() {
        let mut s = Stats::default();
        s.frames = 300;
        s.bytes = 300 * 1024;
        s.elapsed_ms = 10_000;
        assert!((s.fps() - 30.0).abs() < 0.01);
        assert!((s.throughput_bps() - 30.0 * 1024.0).abs() < 0.5);
    }

    #[test]
    fn progress_fraction_and_loss() {
        let p = Progress {
            decoded_symbols: 50,
            total_symbols: 100,
            frames_seen: 100,
            frames_duplicate: 10,
            frames_corrupt: 5,
            decoded_blocks: 2,
            total_blocks: 4,
            ..Default::default()
        };
        assert!((p.decoded_fraction() - 0.5).abs() < 1e-9);
        // loss_ratio = (duplicate + corrupt) / seen = (10 + 5) / 100 = 0.15
        assert!((p.loss_ratio() - 0.15).abs() < 1e-9);
        assert!(!p.is_complete());
    }
}
