//! Decode: module grid or gray buffer → frame bytes.

use crate::{Error, Result};
use crate::Frame;

use super::ecc;
use super::layout::{self, BORDER, MODE_WORD_LEN};
use super::l1_gray;
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
    let max_plen = raw.len().min(side * side / 8);
    let mut recovered = None;
    for plen in (MODE_WORD_LEN + 64)..=max_plen {
        let need = ecc::protected_len(plen);
        if need > raw.len() {
            break;
        }
        if let Some(r) = ecc::unprotect(&raw[..need]) {
            if r.len() == plen {
                recovered = Some(r);
                break;
            }
        }
    }
    let recovered = recovered.ok_or(Error::FrameCrcMismatch)?;
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

/// Try decode with side hint. 先试 expected_side（最可能正确），再向外搜索
/// ±12 模块容忍 sender/receiver 大小漂移。失败 = 丢帧，由 RaptorQ 兜底。
pub fn decode_from_gray(
    gray: &[u8],
    width: usize,
    height: usize,
    expected_side: usize,
) -> Option<Vec<u8>> {
    if gray.len() < width * height || expected_side < 8 {
        return None;
    }
    // 先试精确 side（常见情况，避免无谓搜索开销）
    let modules = l1_gray::sample_modules(gray, width, height, expected_side);
    if let Ok(frame) = decode_from_modules(&modules, expected_side) {
        return Some(frame);
    }
    // 再向外搜索 ±12 模块
    for delta in 1..=12 {
        for side in [expected_side + delta, expected_side.saturating_sub(delta)] {
            if side < 16 {
                continue;
            }
            let modules = l1_gray::sample_modules(gray, width, height, side);
            if let Ok(frame) = decode_from_modules(&modules, side) {
                return Some(frame);
            }
        }
    }
    None
}

pub fn expected_side_for_symbol_size(symbol_size: u32) -> usize {
    layout::side_for_symbol_size(symbol_size)
}
