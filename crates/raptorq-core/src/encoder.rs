use crate::{Config, Error, ObjectMeta, Result, Symbol};
use raptorq::{Encoder as RqEncoder, EncodingPacket, SourceBlockEncoder};

/// Cached source packets for a single block, to avoid O(K) regeneration on
/// every `source_symbol()` call (which was O(K²) for a full pass).
struct CachedBlock {
    encoder: SourceBlockEncoder,
    source_packets: Vec<EncodingPacket>,
}

/// RaptorQ encoder for a single object.
///
/// Source packets are pre-cached at construction time so `source_symbol()` is
/// O(1). Repair symbols are generated on demand from the fountain.
pub struct Encoder {
    config: Config,
    meta: ObjectMeta,
    blocks: Vec<CachedBlock>,
}

impl Encoder {
    pub fn new(data: &[u8], config: Config) -> Result<Self> {
        if data.is_empty() {
            return Err(Error::EmptyData);
        }
        if config.symbol_size == 0 {
            return Err(Error::InvalidSymbolSize);
        }

        let rq_encoder = RqEncoder::with_defaults(data, config.mtu());
        let oti = rq_encoder.get_config();
        let rq_blocks = rq_encoder.get_block_encoders();

        // Pre-cache source packets — O(K) once, not O(K) per call.
        let blocks: Vec<CachedBlock> = rq_blocks
            .iter()
            .map(|b| CachedBlock {
                encoder: b.clone(),
                source_packets: b.source_packets(),
            })
            .collect();
        let meta = ObjectMeta::from_encoder(data.len() as u64, config, &oti, &rq_blocks);

        Ok(Self { config, meta, blocks })
    }

    #[inline]
    pub fn meta(&self) -> &ObjectMeta {
        &self.meta
    }

    #[inline]
    pub fn config(&self) -> Config {
        self.config
    }

    #[inline]
    pub fn num_blocks(&self) -> usize {
        self.blocks.len()
    }

    /// O(1) source symbol lookup via pre-cached packets.
    pub fn source_symbol(&self, sbn: u32, esi: u32) -> Result<Symbol> {
        let block = self.block(sbn)?;
        let k = self.meta.blocks[sbn as usize].num_source_symbols;
        if esi >= k {
            return Err(Error::UnknownSymbol { sbn, esi });
        }
        let pkt = &block.source_packets[esi as usize];
        Ok(Symbol::new(sbn, esi, pkt.data().to_vec()))
    }

    pub fn repair_symbols(&self, sbn: u32, start: u32, count: u32) -> Result<Vec<Symbol>> {
        let block = self.block(sbn)?;
        let k = self.meta.blocks[sbn as usize].num_source_symbols;
        let pkts: Vec<EncodingPacket> = block.encoder.repair_packets(start, count);
        pkts.into_iter().enumerate().map(|(i, p)| {
            let esi = k.checked_add(start).and_then(|s| s.checked_add(i as u32))
                .ok_or_else(|| Error::UnknownSymbol { sbn, esi: u32::MAX })?;
            Ok(Symbol::new(sbn, esi, p.data().to_vec()))
        }).collect()
    }

    pub fn source_symbols(&self, sbn: u32) -> Result<Vec<Symbol>> {
        let block = self.block(sbn)?;
        let k = self.meta.blocks[sbn as usize].num_source_symbols;
        Ok(block.source_packets.iter().enumerate().take(k as usize)
            .map(|(i, p)| Symbol::new(sbn, i as u32, p.data().to_vec())).collect())
    }

    fn block(&self, sbn: u32) -> Result<&CachedBlock> {
        self.blocks.get(sbn as usize).ok_or_else(|| Error::BlockOutOfRange {
            sbn, total: self.blocks.len() as u32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn random_data(n: usize) -> Vec<u8> {
        (0..n).map(|i| ((i * 1103515245 + 12345) & 0xff) as u8).collect()
    }

    #[test]
    fn encodes_and_lists_blocks() {
        let data = random_data(50_000);
        let enc = Encoder::new(&data, Config::default()).unwrap();
        let total_k: u64 = enc.meta().blocks.iter().map(|b| b.num_source_symbols as u64).sum();
        assert!(total_k * 1024 >= 50_000);
    }

    #[test]
    fn source_symbol_roundtrip_sizes() {
        let data = random_data(4096);
        let enc = Encoder::new(&data, Config::default()).unwrap();
        let s0 = enc.source_symbol(0, 0).unwrap();
        assert_eq!(s0.data.len(), 1024);
    }

    #[test]
    fn repair_symbols_have_esi_above_k() {
        let data = random_data(8192);
        let enc = Encoder::new(&data, Config::default()).unwrap();
        let k = enc.meta().blocks[0].num_source_symbols;
        let repairs = enc.repair_symbols(0, 0, 5).unwrap();
        for (i, s) in repairs.iter().enumerate() {
            assert_eq!(s.id.esi, k + i as u32);
        }
    }

    #[test]
    fn large_file_source_symbol_is_fast() {
        let data = random_data(2 * 1024 * 1024);
        let enc = Encoder::new(&data, Config::default()).unwrap();
        let k = enc.meta().blocks[0].num_source_symbols;
        let t = std::time::Instant::now();
        for esi in 0..k {
            let _ = enc.source_symbol(0, esi).unwrap();
        }
        assert!(t.elapsed().as_secs() < 5, "K={} took {:.2}s", k, t.elapsed().as_secs_f64());
    }
}
