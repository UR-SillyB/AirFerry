use std::vec::Vec;

/// Identity of a single RaptorQ symbol within an object.
///
/// - `sbn` (Source Block Number): which source block the symbol belongs to.
/// - `esi` (Encoding Symbol ID): position within the block. Source symbols
///   occupy `esi ∈ [0, K)`, repair symbols `esi ≥ K`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct SymbolId {
    pub sbn: u32,
    pub esi: u32,
}

impl SymbolId {
    #[inline]
    pub fn new(sbn: u32, esi: u32) -> Self {
        Self { sbn, esi }
    }
}

/// A single RaptorQ symbol: its identity plus the raw symbol bytes.
///
/// The byte length always equals the configured `symbol_size`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Symbol {
    pub id: SymbolId,
    pub data: Vec<u8>,
}

impl Symbol {
    #[inline]
    pub fn new(sbn: u32, esi: u32, data: Vec<u8>) -> Self {
        Self {
            id: SymbolId::new(sbn, esi),
            data,
        }
    }
}
