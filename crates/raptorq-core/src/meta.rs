use crate::Config;
use raptorq::ObjectTransmissionInformation;

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
    /// Total bytes of original data in this block (may be < K*T for the last block).
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
}
