//! Decode: module grid or gray buffer → frame bytes.

use crate::{Error, Result};
use crate::Frame;

use super::ecc;
use super::layout::{self, BORDER, MODE_WORD_LEN};
use super::mode_word::ModeWord;

fn bits_to_bytes(modules: &[u8], side: usize) -> Vec<u8> {
    let data_side = side.saturating_sub(2 * BORDER);
    let bit_count = data_side * data_side;
    let mut raw = vec![0u8; (bit_count + 7) / 8];
    let mut bit_idx = 0usize;
    for y in BORDER..(side - BORDER) {
        for x in BORDER..(side - BORDER) {
            if bit_idx >= bit_count {
                break;
            }
            if modules[y * side + x] != 0 {
                raw[bit_idx / 8] |= 1 << (7 - (bit_idx % 8));
            }
            bit_idx += 1;
        }
    }
    raw
}

pub fn decode_from_modules(modules: &[u8], side: usize) -> Result<Vec<u8>> {
    if side < 3 || modules.len() < side * side {
        return Err(Error::BufferTooShort {
            need: side * side,
            have: modules.len(),
        });
    }
    let raw = bits_to_bytes(modules, side);
    let recovered = ecc::unprotect(&raw).ok_or(Error::FrameCrcMismatch)?;
    if recovered.len() < MODE_WORD_LEN + 64 {
        return Err(Error::BufferTooShort {
            need: MODE_WORD_LEN + 64,
            have: recovered.len(),
        });
    }
    let mode = ModeWord::from_bytes([recovered[0], recovered[1]]);
    if !mode.is_supported() {
        return Err(Error::BadVersion(0));
    }
    let frame_bytes = &recovered[MODE_WORD_LEN..];
    Frame::from_bytes(frame_bytes)?;
    Ok(frame_bytes.to_vec())
}

pub fn decode_from_gray(
    gray: &[u8],
    width: usize,
    height: usize,
    expected_side: usize,
) -> Option<Vec<u8>> {
    if gray.len() < width * height || expected_side < 8 {
        return None;
    }
    let mut sum: u64 = 0;
    for &p in gray.iter().take(width * height) {
        sum += p as u64;
    }
    let thresh = (sum / (width * height) as u64) as u8;
    let mut modules = vec![0u8; expected_side * expected_side];
    for y in 0..expected_side {
        for x in 0..expected_side {
            let sx = x * width / expected_side;
            let sy = y * height / expected_side;
            let idx = sy * width + sx;
            modules[y * expected_side + x] = if gray[idx] < thresh { 1 } else { 0 };
        }
    }
    decode_from_modules(&modules, expected_side).ok()
}

pub fn expected_side_for_symbol_size(symbol_size: u32) -> usize {
    layout::side_for_symbol_size(symbol_size)
}
