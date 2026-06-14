//! QR matrix rendering.
//!
//! Encodes frame bytes into a fixed Version-40 / Error-Correction-L QR code
//! and exposes the resulting module matrix as a flat `Vec<bool>` (`true` ==
//! dark module) plus the side length. The display layer (Canvas on the
//! browser, native draw on Android) maps this matrix to pixels.
//!
//! Version 40 / L holds up to 2953 bytes of binary data — comfortably more
//! than our 1088-byte frame (60 header + 1024 payload + 4 footer), keeping
//! module density low for scan reliability.

use crate::{Error, Result};
use qrcode::{EcLevel, QrCode, Version};
use std::vec::Vec;

/// QR parameters used by EasyTransfer.
pub const QR_VERSION: Version = Version::Normal(40);
pub const QR_EC_LEVEL: EcLevel = EcLevel::L;
/// Maximum payload (bytes) a Version-40 / L QR can carry in binary mode.
pub const QR_MAX_BYTES: usize = 2953;

/// A rendered QR code: flat module grid (row-major) + side length.
#[derive(Debug, Clone)]
pub struct QrMatrix {
    /// `true` = dark module, `false` = light module. Row-major.
    pub modules: Vec<bool>,
    /// Modules per side (e.g. 177 for Version 40).
    pub size: usize,
}

impl QrMatrix {
    #[inline]
    pub fn get(&self, x: usize, y: usize) -> bool {
        self.modules[y * self.size + x]
    }
}

/// Encode `data` into a Version-40 / L QR matrix.
///
/// `data` must be ≤ [`QR_MAX_BYTES`]; the caller (frame layer) guarantees this
/// since frames are fixed at 1088 bytes.
pub fn encode(data: &[u8]) -> Result<QrMatrix> {
    if data.len() > QR_MAX_BYTES {
        return Err(Error::BufferTooShort {
            need: QR_MAX_BYTES,
            have: data.len(),
        });
    }
    let code = QrCode::with_version(data, QR_VERSION, QR_EC_LEVEL)
        .map_err(|_| Error::BufferTooShort {
            need: QR_MAX_BYTES,
            have: data.len(),
        })?;
    let size = code.width();
    let modules = code
        .to_colors()
        .into_iter()
        .map(|c| c != qrcode::types::Color::Light)
        .collect();
    Ok(QrMatrix { modules, size })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_frame_sized_payload() {
        let data = vec![0u8; 1088];
        let m = encode(&data).unwrap();
        // Version 40 → 177 modules per side.
        assert_eq!(m.size, 177);
        assert_eq!(m.modules.len(), 177 * 177);
    }

    #[test]
    fn rejects_oversized_payload() {
        let data = vec![0u8; QR_MAX_BYTES + 1];
        assert!(encode(&data).is_err());
    }

    #[test]
    fn deterministic_encoding() {
        let data = vec![42u8; 500];
        let a = encode(&data).unwrap();
        let b = encode(&data).unwrap();
        assert_eq!(a.modules, b.modules);
    }
}
