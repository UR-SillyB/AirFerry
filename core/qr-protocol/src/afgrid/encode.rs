//! Encode frame bytes → module matrix.

use crate::{Error, Result};
use crate::qr_render::QrMatrix;

use super::ecc;
use super::layout::{self, BORDER, MODE_WORD_LEN};
use super::matrix::AfMatrix;
use super::mode_word::ModeWord;

pub fn encode_frame_bytes(frame: &[u8]) -> Result<QrMatrix> {
    if frame.is_empty() {
        return Err(Error::BufferTooShort { need: 1, have: 0 });
    }
    let mut payload = Vec::with_capacity(MODE_WORD_LEN + frame.len());
    payload.extend_from_slice(&ModeWord::DEFAULT.to_bytes());
    payload.extend_from_slice(frame);
    let protected = ecc::protect(&payload);
    let data_side = layout::data_side_for_frame_len(frame.len());
    let bits_needed = protected.len() * 8;
    if data_side * data_side < bits_needed {
        return Err(Error::BufferTooShort {
            need: bits_needed,
            have: data_side * data_side,
        });
    }
    let side = data_side + 2 * BORDER;
    let mut m = AfMatrix::new(side);
    m.paint_border();
    let mut bit_idx = 0usize;
    for y in BORDER..(side - BORDER) {
        for x in BORDER..(side - BORDER) {
            let byte_i = bit_idx / 8;
            let bit_i = 7 - (bit_idx % 8);
            let dark = if byte_i < protected.len() {
                (protected[byte_i] >> bit_i) & 1 == 1
            } else {
                false
            };
            m.set(x, y, dark);
            bit_idx += 1;
        }
    }
    Ok(QrMatrix {
        modules: m.modules,
        size: m.size,
    })
}
