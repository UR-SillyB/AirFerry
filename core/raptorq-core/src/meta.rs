use crate::Config;
use raptorq::ObjectTransmissionInformation;

/// RFC 6330 §5.1.2 ceiling on source symbols per block (K'_max). raptorq
/// `assert!`s on this internally, so a descriptor must never exceed it.
pub const MAX_SOURCE_SYMBOLS_PER_BLOCK: u32 = 56403;
/// RFC 6330 ceiling on the number of source blocks (Z_max).
pub const MAX_SOURCE_BLOCKS: usize = 256;

/// Metadata describing how an object was split into RaptorQ source blocks.
///
/// This is the minimum information a receiver needs to reconstruct the object
/// (it mirrors the RFC 6330 OTI plus the per-block symbol counts, which the
/// underlying crate derives but does not expose directly).
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct SourceBlockMeta {
    /// Source Block Number (0-based).
    pub sbn: u32,
    /// Number of source symbols K in this block.
    pub num_source_symbols: u32,
    /// Total bytes carried by this block. **Invariant: `block_length ==
    /// num_source_symbols * symbol_size`** for *every* block, including the
    /// last one. This holds because the input is zero-padded to a whole symbol
    /// count before encoding (`chunker::pad_to_symbols`), and `raptorq` further
    /// zero-pads each block to a whole symbol boundary internally. The decoder
    /// derives `K = ceil(block_length / symbol_size)`, so any deviation from
    /// this invariant would produce a wrong K and corrupt recovery.
    pub block_length: u64,
}

/// Object metadata carried alongside the symbol stream.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ObjectMeta {
    /// Original (pre-RaptorQ) byte length of the object.
    pub transfer_length: u64,
    pub symbol_size: u32,
    /// Wire-format OTI (12 bytes, RFC 6330 §5.1.1) — the canonical way to
    /// rebuild the decoder. Equivalent to the OTI fields above.
    pub oti_bytes: [u8; 12],
    pub blocks: Vec<SourceBlockMeta>,
}

impl ObjectMeta {
    /// Build metadata by encoding `data` with `config` (without retaining the
    /// whole packet set — used by the encoder to publish per-block K, and by
    /// tests to construct a decoder peer).
    pub(crate) fn from_encoder(
        data_len: u64,
        config: Config,
        oti: &ObjectTransmissionInformation,
        blocks: &[raptorq::SourceBlockEncoder],
    ) -> Self {
        let block_metas = blocks
            .iter()
            .enumerate()
            .map(|(i, enc)| {
                // K = number of source symbols the encoder was built with.
                // The underlying field is private; derive K from source_packets().
                let k = enc.source_packets().len() as u32;
                let block_length = u64::from(k) * u64::from(config.symbol_size);
                SourceBlockMeta {
                    sbn: i as u32,
                    num_source_symbols: k,
                    block_length,
                }
            })
            .collect();

        ObjectMeta {
            transfer_length: data_len,
            symbol_size: config.symbol_size,
            oti_bytes: oti.serialize(),
            blocks: block_metas,
        }
    }

    /// Reconstruct the underlying OTI from its wire bytes.
    pub fn oti(&self) -> ObjectTransmissionInformation {
        ObjectTransmissionInformation::deserialize(&self.oti_bytes)
    }

    /// Validate metadata before it is used to build a decoder.
    ///
    /// The receiver constructs an `ObjectMeta` from a **descriptor frame decoded
    /// off an arbitrary screen** — i.e. fully attacker-controllable bytes that
    /// only had to pass a CRC32 (which an attacker computes themselves). The
    /// underlying `raptorq` crate is written for *trusted* parameters and will
    /// panic (divide-by-zero, `assert!`, slice out-of-range) or allocate
    /// gigabytes on hostile values. Because the workspace builds with
    /// `panic = "abort"`, any such panic crashes the whole receiver. This gate
    /// rejects every metadata shape the legitimate encoder never produces, so a
    /// malicious descriptor is dropped instead of crashing the app.
    ///
    /// Returns `Ok(())` for valid metadata, or `Err(reason)` to reject.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.symbol_size == 0 || self.symbol_size > u16::MAX as u32 {
            return Err("symbol_size out of range");
        }
        // The decoder divides block_length by — and slices payloads using — the
        // OTI symbol size. A zero value divides-by-zero; a value != our
        // symbol_size slices past the actual payload length.
        let oti = self.oti();
        if oti.symbol_size() == 0 || oti.symbol_size() as u32 != self.symbol_size {
            return Err("OTI symbol_size invalid or mismatched");
        }
        if self.blocks.is_empty() || self.blocks.len() > MAX_SOURCE_BLOCKS {
            return Err("source block count out of range");
        }
        let mut total_block_len: u64 = 0;
        for b in &self.blocks {
            // block_progress indexes meta.blocks[sbn]; keep sbn in range.
            if b.sbn as usize >= self.blocks.len() {
                return Err("block sbn out of range");
            }
            if b.num_source_symbols == 0 || b.num_source_symbols > MAX_SOURCE_SYMBOLS_PER_BLOCK {
                return Err("block K out of range");
            }
            // Invariant (see SourceBlockMeta): block_length == K * symbol_size.
            // This also bounds the decoder's `vec![None; K]` allocation.
            let expect = b.num_source_symbols as u64 * self.symbol_size as u64;
            if b.block_length != expect {
                return Err("block_length inconsistent with K*symbol_size");
            }
            total_block_len = total_block_len.saturating_add(b.block_length);
        }
        // assemble() reserves `transfer_length` bytes; it can never legitimately
        // exceed the bytes the blocks actually carry.
        if self.transfer_length > total_block_len {
            return Err("transfer_length exceeds total block bytes");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Config, Encoder};

    fn real_meta() -> ObjectMeta {
        let data: Vec<u8> = (0..40_000).map(|i| (i & 0xff) as u8).collect();
        Encoder::new(&data, Config::default()).unwrap().meta().clone()
    }

    /// The legitimate encoder's metadata MUST pass validation — guards against
    /// the gate being too strict (which would reject real transfers). Also
    /// confirms the OTI symbol_size == meta.symbol_size assumption the gate uses.
    #[test]
    fn real_meta_passes_validation() {
        real_meta().validate().expect("legitimate meta must validate");
        // 512-byte symbols (the browser default) must validate too.
        let data: Vec<u8> = (0..40_000).map(|i| (i & 0xff) as u8).collect();
        let enc = Encoder::new(&data, Config::new(512).unwrap()).unwrap();
        enc.meta().validate().expect("512-byte-symbol meta must validate");
    }

    #[test]
    fn rejects_zero_symbol_size() {
        let mut m = real_meta();
        m.symbol_size = 0;
        assert!(m.validate().is_err());
    }

    #[test]
    fn rejects_oversized_block_k() {
        let mut m = real_meta();
        let b = m.blocks.first_mut().unwrap();
        b.num_source_symbols = MAX_SOURCE_SYMBOLS_PER_BLOCK + 1;
        b.block_length = b.num_source_symbols as u64 * m.symbol_size as u64;
        assert!(m.validate().is_err());
    }

    #[test]
    fn rejects_block_length_mismatch() {
        let mut m = real_meta();
        m.blocks.first_mut().unwrap().block_length += 1;
        assert!(m.validate().is_err());
    }

    #[test]
    fn rejects_transfer_length_overflow() {
        let mut m = real_meta();
        m.transfer_length = u64::MAX;
        assert!(m.validate().is_err());
    }

    #[test]
    fn rejects_empty_blocks() {
        let mut m = real_meta();
        m.blocks.clear();
        assert!(m.validate().is_err());
    }
}
