use crate::Config;
use raptorq::ObjectTransmissionInformation;

/// RFC 6330 §5.1.2 ceiling on source symbols per block (K'_max). raptorq
/// `assert!`s on this internally, so a descriptor must never exceed it.
pub const MAX_SOURCE_SYMBOLS_PER_BLOCK: u32 = 56403;
/// RFC 6330 ceiling on the number of source blocks (Z_max).
pub const MAX_SOURCE_BLOCKS: usize = 256;
/// Wire (compressed) transfer ceiling. This bounds the **RaptorQ object length**
/// — the compressed payload carried symbol-by-symbol over the QR stream
/// (`ObjectMeta::transfer_length`). It is deliberately conservative: a 32 MiB
/// QR transfer is already extremely long to play out, and it keeps the decoder's
/// block-state allocations modest on phones and browsers.
pub const MAX_OBJECT_BYTES: u64 = 32 * 1024 * 1024;
/// Receiver budget for the **original (post-decompression) size** — the output
/// ceiling of the C-ABI decompression entry points. Kept separate from
/// [`MAX_OBJECT_BYTES`] so a highly-compressible object — compressed under 32 MiB
/// on the wire but expanding far beyond it — can still be recovered. This is a
/// native-memory budget (Rust receiver allocates on the native heap, not the
/// Android/JS GC heap). 256 MiB matches the pre-v1.1.4 allowance; it does NOT
/// relax the wire/transfer ceiling ([`MAX_OBJECT_BYTES`] still caps what is
/// actually transmitted), and the XZ decoder additionally enforces its own 128
/// MiB streaming memory ceiling.
pub const MAX_ORIGINAL_BYTES: u64 = 256 * 1024 * 1024;
/// Bound the eager `Vec<Option<Symbol>>` allocations made by the upstream
/// decoder independently from the encoded byte length.
pub const MAX_TOTAL_SOURCE_SYMBOLS: u64 = 524_288;

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
                let block_length = u64::from(k) * u64::from(config.symbol_size());
                SourceBlockMeta {
                    sbn: i as u32,
                    num_source_symbols: k,
                    block_length,
                }
            })
            .collect();

        ObjectMeta {
            transfer_length: data_len,
            symbol_size: config.symbol_size(),
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
        if Config::new(self.symbol_size).is_err() {
            return Err("symbol_size out of range");
        }
        // The decoder divides block_length by — and slices payloads using — the
        // OTI symbol size. A zero value divides-by-zero; a value != our
        // symbol_size slices past the actual payload length.
        let oti = self.oti();
        if oti.symbol_size() == 0 || oti.symbol_size() as u32 != self.symbol_size {
            return Err("OTI symbol_size invalid or mismatched");
        }
        if oti.transfer_length() != self.transfer_length {
            return Err("OTI transfer_length mismatched");
        }
        if oti.sub_blocks() == 0 || oti.symbol_alignment() == 0 {
            return Err("OTI sub-block/alignment must be non-zero");
        }
        if oti.symbol_size() % u16::from(oti.symbol_alignment()) != 0 {
            return Err("OTI symbol_size is not alignment-divisible");
        }
        let aligned_units = oti.symbol_size() / u16::from(oti.symbol_alignment());
        if oti.sub_blocks() > aligned_units {
            return Err("OTI sub-block count exceeds aligned symbol units");
        }
        if self.oti_bytes[5] != 0 {
            return Err("OTI reserved byte must be zero");
        }
        if self.transfer_length == 0 || self.transfer_length > MAX_OBJECT_BYTES {
            return Err("transfer_length exceeds local receiver budget");
        }
        if self.blocks.is_empty()
            || self.blocks.len() > MAX_SOURCE_BLOCKS
            || self.blocks.len() > u8::MAX as usize
        {
            return Err("source block count out of range");
        }
        if usize::from(oti.source_blocks()) != self.blocks.len() {
            return Err("OTI source block count mismatched");
        }
        let mut total_block_len: u64 = 0;
        let mut total_k: u64 = 0;
        for (index, b) in self.blocks.iter().enumerate() {
            if b.sbn != index as u32 {
                return Err("block sbn must equal its canonical index");
            }
            if b.num_source_symbols == 0 || b.num_source_symbols > MAX_SOURCE_SYMBOLS_PER_BLOCK {
                return Err("block K out of range");
            }
            // Invariant (see SourceBlockMeta): block_length == K * symbol_size.
            // This also bounds the decoder's `vec![None; K]` allocation.
            let expect = u64::from(b.num_source_symbols)
                .checked_mul(u64::from(self.symbol_size))
                .ok_or("block_length overflow")?;
            if b.block_length != expect {
                return Err("block_length inconsistent with K*symbol_size");
            }
            total_block_len = total_block_len
                .checked_add(b.block_length)
                .ok_or("total block length overflow")?;
            total_k = total_k
                .checked_add(u64::from(b.num_source_symbols))
                .ok_or("total source symbol count overflow")?;
        }
        if total_k > MAX_TOTAL_SOURCE_SYMBOLS {
            return Err("total source symbol count exceeds local receiver budget");
        }
        let padding_budget = u64::from(self.symbol_size)
            .checked_mul(self.blocks.len() as u64)
            .ok_or("padding budget overflow")?;
        if total_block_len
            > MAX_OBJECT_BYTES
                .checked_add(padding_budget)
                .ok_or("decoder byte budget overflow")?
        {
            return Err("decoder bytes exceed local receiver budget");
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
        Encoder::new(&data, Config::default())
            .unwrap()
            .meta()
            .clone()
    }

    /// The legitimate encoder's metadata MUST pass validation — guards against
    /// the gate being too strict (which would reject real transfers). Also
    /// confirms the OTI symbol_size == meta.symbol_size assumption the gate uses.
    #[test]
    fn real_meta_passes_validation() {
        real_meta()
            .validate()
            .expect("legitimate meta must validate");
        // 512-byte symbols (the browser default) must validate too.
        let data: Vec<u8> = (0..40_000).map(|i| (i & 0xff) as u8).collect();
        let enc = Encoder::new(&data, Config::new(512).unwrap()).unwrap();
        enc.meta()
            .validate()
            .expect("512-byte-symbol meta must validate");
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

    #[test]
    fn rejects_oti_zero_alignment_and_sub_blocks() {
        let mut m = real_meta();
        m.oti_bytes[11] = 0;
        assert!(m.validate().is_err());

        let mut m = real_meta();
        m.oti_bytes[9] = 0;
        m.oti_bytes[10] = 0;
        assert!(m.validate().is_err());
    }

    #[test]
    fn rejects_noncanonical_sbn() {
        let mut m = real_meta();
        m.blocks[0].sbn = 1;
        assert!(m.validate().is_err());
    }
}
