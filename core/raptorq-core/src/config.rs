use crate::Result;

/// Default per-symbol (== per-QR-payload) size: 1024 bytes.
///
/// Chosen to keep the full frame (header + payload + footer) well within the
/// Version-40 / Error-Correction-L capacity of 2953 bytes, which keeps QR
/// module density low and dramatically improves scan reliability.
pub const DEFAULT_SYMBOL_SIZE: u32 = 1024;

/// RaptorQ MTU includes the 4-byte `PayloadId` header the underlying crate
/// prepends to every packet. Our public symbol size is the *payload* size, so
/// the internal MTU = symbol_size + 4.
const PAYLOAD_ID_SIZE: u16 = 4;

/// Codec configuration.
///
/// `symbol_size` is the size of a single RaptorQ symbol in bytes and is also
/// the size of every QR frame payload (see `qr-protocol`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Config {
    pub symbol_size: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            symbol_size: DEFAULT_SYMBOL_SIZE,
        }
    }
}

impl Config {
    pub fn new(symbol_size: u32) -> Result<Self> {
        if symbol_size == 0 {
            return Err(crate::Error::InvalidSymbolSize);
        }
        // raptorq stores symbol_size as u16.
        if symbol_size > u16::MAX as u32 {
            return Err(crate::Error::InvalidSymbolSize);
        }
        Ok(Self { symbol_size })
    }

    /// MTU as expected by `raptorq::Encoder::with_defaults` (payload + PayloadId).
    #[inline]
    pub(crate) fn mtu(&self) -> u16 {
        self.symbol_size as u16 + PAYLOAD_ID_SIZE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_1024() {
        assert_eq!(Config::default().symbol_size, 1024);
    }

    #[test]
    fn rejects_zero_symbol_size() {
        assert!(Config::new(0).is_err());
    }

    #[test]
    fn rejects_huge_symbol_size() {
        assert!(Config::new(0x1_0000).is_err());
        assert!(Config::new(1024).is_ok());
    }
}
