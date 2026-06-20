//! QR matrix rendering.
//!
//! Encodes frame bytes into the *smallest* Error-Correction-L QR version that
//! holds the frame, and exposes the resulting module matrix as a flat
//! `Vec<bool>` (`true` == dark module) plus the side length. The display layer
//! (Canvas on the browser, native draw on Android) maps this matrix to pixels.
//!
//! ## Why the minimal version (not a fixed Version 40)
//!
//! A Version-40 code is 177×177 modules — the densest QR there is. Forcing it
//! for a frame that only needs ~V23 wastes module budget and makes the code
//! hard for a phone camera to resolve, which manifests as the receiver never
//! accepting data symbols (stuck at "恢复中 0%"). We therefore pick the
//! smallest version whose *byte-mode* L capacity fits the frame: byte mode is
//! the worst case, so the optimally-segmented encoding always fits, and —
//! because the frame size is constant within a session — every frame renders
//! at the same fixed version, keeping the on-screen QR size stable for the
//! scanning camera. A 1088-byte frame drops from V40 (177²) to V23 (109²); the
//! smaller 576-byte default frame lands on V16 (81²), far easier to scan.

use crate::{Error, Result};
use qrcode::{EcLevel, QrCode, Version};
use std::vec::Vec;

/// QR parameters used by EasyTransfer.
pub const QR_EC_LEVEL: EcLevel = EcLevel::L;
/// Maximum payload (bytes) a Version-40 / L QR can carry in binary mode.
pub const QR_MAX_BYTES: usize = 2953;

/// Byte-mode data capacity (bytes) for QR Versions 1..=40 at EC level L
/// (ISO/IEC 18004 Table 7). Index `i` is the capacity of `Version::Normal(i+1)`.
const QR_BYTE_CAPACITY_L: [usize; 40] = [
    17, 32, 53, 78, 106, 134, 154, 192, 230, 271,
    321, 367, 425, 458, 520, 586, 644, 718, 792, 858,
    929, 1003, 1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732,
    1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953,
];

/// Smallest QR version whose byte-mode EC-L capacity holds `len` bytes, or
/// `None` if `len` exceeds Version 40's capacity ([`QR_MAX_BYTES`]).
pub fn min_version_for(len: usize) -> Option<Version> {
    QR_BYTE_CAPACITY_L
        .iter()
        .position(|&cap| cap >= len)
        .map(|i| Version::Normal((i + 1) as i16))
}

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

/// Encode `data` into the smallest EC-L QR version that holds it.
///
/// Starts at the version suggested by the byte-mode capacity table
/// ([`min_version_for`]) and, if that exact version refuses to encode the data,
/// walks upward version by version up to Version 40. This fallback matters for
/// the high-speed symbol sizes: a payload exactly at a version's nominal
/// byte-mode capacity can still fail `with_version` for certain byte patterns
/// (the segmenter/bit-stream packing occasionally needs one more version than
/// the table predicts). Without the fallback, a single un-encodable repair
/// frame aborts the whole render tick; empirically ~3 in 500 random 1024-byte
/// repair frames fail at V23. Walking up guarantees every in-range frame
/// renders, so the high-speed tier never stutters.
///
/// `data` must be ≤ [`QR_MAX_BYTES`]; the caller (frame layer) guarantees this
/// since frames are fixed-size and well under a Version-40 payload.
pub fn encode(data: &[u8]) -> Result<QrMatrix> {
    let start = min_version_for(data.len()).ok_or(Error::BufferTooShort {
        need: QR_MAX_BYTES,
        have: data.len(),
    })?;
    // `min_version_for` returns `Version::Normal(v)` with v in 1..=40. Walk from
    // that version up to 40 inclusive, returning the first that encodes.
    let start_v = match start {
        Version::Normal(v) => v,
        // Micro codes aren't produced here (we always request Normal); defend.
        _ => 1,
    };
    for v in start_v..=40 {
        if let Ok(code) = QrCode::with_version(data, Version::Normal(v), QR_EC_LEVEL) {
            let size = code.width();
            let modules = code
                .to_colors()
                .into_iter()
                .map(|c| c != qrcode::types::Color::Light)
                .collect();
            return Ok(QrMatrix { modules, size });
        }
    }
    Err(Error::BufferTooShort {
        need: QR_MAX_BYTES,
        have: data.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_frame_sized_payload() {
        // A 1088-byte frame fits in Version 23 (109×109) at EC-L — far sparser
        // than the old forced Version 40 (177×177).
        let data = vec![0u8; 1088];
        let m = encode(&data).unwrap();
        assert_eq!(m.size, 109);
        assert_eq!(m.modules.len(), 109 * 109);
    }

    #[test]
    fn picks_minimal_version() {
        assert_eq!(min_version_for(1088), Some(Version::Normal(23)));
        assert_eq!(min_version_for(576), Some(Version::Normal(16)));
        assert_eq!(min_version_for(17), Some(Version::Normal(1)));
        assert_eq!(min_version_for(QR_MAX_BYTES), Some(Version::Normal(40)));
        assert_eq!(min_version_for(QR_MAX_BYTES + 1), None);
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
