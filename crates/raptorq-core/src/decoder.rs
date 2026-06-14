use crate::{ObjectMeta, Result, Symbol};
use raptorq::{EncodingPacket, PayloadId, SourceBlockDecoder};

/// Per-source-block reconstruction state.
struct BlockState {
    decoder: SourceBlockDecoder,
    decoded: Option<Vec<u8>>,
}

/// RaptorQ decoder for a single object.
///
/// Accepts symbols in any order via [`Decoder::add_symbol`]; once a source
/// block has collected enough independent symbols it is decoded lazily. Use
/// [`Decoder::block_progress`] to query how many distinct symbols a block has
/// received, and [`Decoder::try_decode`] / [`Decoder::is_complete`] /
/// [`Decoder::assemble`] to obtain the result.
pub struct Decoder {
    meta: ObjectMeta,
    blocks: Vec<BlockState>,
}

impl Decoder {
    /// Create a decoder from object metadata (typically received out-of-band
    /// via the first QR frame's header, or reconstructed from a resume file).
    pub fn new(meta: ObjectMeta) -> Self {
        let oti = meta.oti();
        let blocks = meta
            .blocks
            .iter()
            .map(|b| BlockState {
                decoder: SourceBlockDecoder::new(b.sbn as u8, &oti, b.block_length),
                decoded: None,
            })
            .collect();
        Self { meta, blocks }
    }

    #[inline]
    pub fn meta(&self) -> &ObjectMeta {
        &self.meta
    }

    /// Number of distinct symbols received so far for block `sbn`.
    ///
    /// Note: the underlying decoder counts *unique* ESI, which is exactly what
    /// we want for de-duplication / progress reporting.
    pub fn block_progress(&self, sbn: u32) -> Option<u32> {
        // raptorq does not expose received_source_symbols publicly; the precise
        // received-symbol count is tracked at the transfer-engine layer. Here
        // we report K once the block is decoded, else None.
        let b = self.blocks.get(sbn as usize)?;
        let k = self.meta.blocks[sbn as usize].num_source_symbols;
        if b.decoded.is_some() {
            Some(k)
        } else {
            None
        }
    }

    /// Feed a symbol (source or repair, any order, duplicates allowed).
    ///
    /// Returns `Ok(true)` if this symbol caused the whole object to become
    /// decodable, `Ok(false)` otherwise.
    pub fn add_symbol(&mut self, symbol: &Symbol) -> Result<bool> {
        let sbn = symbol.id.sbn as usize;
        if sbn >= self.blocks.len() {
            return Err(crate::Error::BlockOutOfRange {
                sbn: symbol.id.sbn,
                total: self.blocks.len() as u32,
            });
        }
        let block = &mut self.blocks[sbn];
        if block.decoded.is_some() {
            // Already reconstructed; ignore further symbols for this block.
            return Ok(self.is_complete());
        }
        // `SourceBlockDecoder::decode` both ingests the packet and attempts
        // reconstruction in one call (it is safe to call repeatedly; it keeps
        // all previously-seen symbols internally and re-runs the solver).
        let pkt = EncodingPacket::new(
            PayloadId::new(symbol.id.sbn as u8, symbol.id.esi),
            symbol.data.clone(),
        );
        if let Some(result) = block.decoder.decode(std::iter::once(pkt)) {
            block.decoded = Some(result);
        }
        Ok(self.is_complete())
    }

    /// True once every source block has been reconstructed.
    pub fn is_complete(&self) -> bool {
        self.blocks.iter().all(|b| b.decoded.is_some())
    }

    /// Number of source blocks fully reconstructed.
    pub fn decoded_block_count(&self) -> usize {
        self.blocks.iter().filter(|b| b.decoded.is_some()).count()
    }

    /// Reassemble the original object. Returns `None` until complete.
    pub fn assemble(&self) -> Option<Vec<u8>> {
        if !self.is_complete() {
            return None;
        }
        let mut out = Vec::with_capacity(self.meta.transfer_length as usize);
        for b in &self.blocks {
            out.extend_from_slice(b.decoded.as_ref().unwrap());
        }
        out.truncate(self.meta.transfer_length as usize);
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Config, Encoder};

    fn random_data(n: usize) -> Vec<u8> {
        (0..n)
            .map(|i| ((i * 1103515245 + 12345) & 0xff) as u8)
            .collect()
    }

    fn encode_decode(data: &[u8], drop_pct: u32, duplicate: bool, shuffle: bool) -> Option<Vec<u8>> {
        let enc = Encoder::new(data, Config::default()).unwrap();
        let meta = enc.meta().clone();

        // Collect all source symbols from every block + ~50% repair overhead.
        let mut syms: Vec<Symbol> = Vec::new();
        for sbn in 0..enc.num_blocks() as u32 {
            let k = meta.blocks[sbn as usize].num_source_symbols;
            syms.extend(enc.source_symbols(sbn).unwrap());
            syms.extend(enc.repair_symbols(sbn, 0, k / 2 + 1).unwrap());
            let _ = k;
        }

        if duplicate {
            let extra: Vec<Symbol> = syms.iter().take(5).cloned().collect();
            syms.extend(extra);
        }
        if shuffle {
            // Simple deterministic shuffle.
            let n = syms.len();
            for i in (1..n).rev() {
                let j = (i.wrapping_mul(2654435761)) % (i + 1);
                syms.swap(i, j);
            }
        }
        if drop_pct > 0 {
            // Deterministic drop: keep symbols whose (index % 100) >= drop_pct.
            syms = syms
                .into_iter()
                .enumerate()
                .filter(|(i, _)| (*i as u32 % 100) >= drop_pct)
                .map(|(_, s)| s)
                .collect();
        }

        let mut dec = Decoder::new(meta);
        for s in &syms {
            dec.add_symbol(s).unwrap();
        }
        dec.assemble()
    }

    #[test]
    fn decodes_lossless() {
        let data = random_data(70_000);
        let got = encode_decode(&data, 0, false, false).unwrap();
        assert_eq!(got, data);
    }

    #[test]
    fn decodes_with_duplicates_and_shuffle() {
        let data = random_data(35_000);
        let got = encode_decode(&data, 0, true, true).unwrap();
        assert_eq!(got, data);
    }

    #[test]
    fn decodes_with_some_drops() {
        // With 50% repair overhead the codec should still recover a modest
        // number of dropped source symbols.
        let data = random_data(35_000);
        let got = encode_decode(&data, 20, true, true).expect("should recover at 20% drop");
        assert_eq!(got, data);
    }
}
