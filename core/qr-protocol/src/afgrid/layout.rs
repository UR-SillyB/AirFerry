//! Matrix layout: border + data region.

use super::ecc;
use super::mode_word::ModeWord;

pub const BORDER: usize = 1;
pub const MODE_WORD_LEN: usize = 2;
pub const SYMBOL_SIZE_MIN: u32 = 256;
pub const SYMBOL_SIZE_MAX: u32 = 16384;

pub fn payload_len_for_frame(frame_len: usize) -> usize {
    MODE_WORD_LEN + frame_len
}

pub fn data_side_for_frame_len(frame_len: usize) -> usize {
    let plen = payload_len_for_frame(frame_len);
    let prot = ecc::protected_len(plen);
    let bits = prot * 8;
    let d = (bits as f64).sqrt().ceil() as usize;
    d.max(8)
}

pub fn side_for_frame_len(frame_len: usize) -> usize {
    data_side_for_frame_len(frame_len) + 2 * BORDER
}

pub fn side_for_symbol_size(symbol_size: u32) -> usize {
    let frame_len = crate::frame::Frame::wire_size(symbol_size);
    side_for_frame_len(frame_len)
}
