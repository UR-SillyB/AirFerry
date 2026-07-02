//! AFGrid — custom 2D barcode (monochrome v1).
//!
//! Output contract matches [`crate::qr_render::QrMatrix`] / `encode` for the WASM render loop.

mod decode;
mod ecc;
mod encode;
mod layout;
mod matrix;
mod mode_word;

pub use decode::{decode_from_gray, decode_from_modules, expected_side_for_symbol_size};
pub use encode::encode_frame_bytes;
pub use layout::{side_for_symbol_size, SYMBOL_SIZE_MAX, SYMBOL_SIZE_MIN};

/// Encode wire bytes (full frame) into a module matrix.
pub fn encode(data: &[u8]) -> crate::Result<crate::qr_render::QrMatrix> {
    encode_frame_bytes(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Frame;

    #[test]
    fn roundtrip_small_frame() {
        let sym = 512u32;
        let frame = Frame::build(
            1u128,
            0,
            0,
            0,
            1,
            10,
            sym,
            1,
            0,
            &vec![0xAB; sym as usize],
        );
        let bytes = frame.to_bytes();
        let m = encode(&bytes).unwrap();
        let back = decode_from_modules(
            &m.modules.iter().map(|&b| b as u8).collect::<Vec<_>>(),
            m.size,
        )
        .unwrap();
        assert_eq!(back, bytes);
    }

    #[test]
    fn side_for_5600() {
        let s = side_for_symbol_size(5600);
        assert!(s >= 200 && s <= 250);
    }
}
