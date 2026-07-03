//! AFGrid — custom 2D barcode (monochrome v1).
//!
//! Output contract matches [`crate::qr_render::QrMatrix`] / `encode` for the WASM render loop.

mod decode;
mod ecc;
mod encode;
mod layout;
pub mod l1_gray;
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
    fn gray_roundtrip_synthetic() {
        let sym = 512u32;
        let frame = Frame::build(1u128, 0, 0, 0, 1, 10, sym, 1, 0, &vec![0x42; sym as usize]);
        let bytes = frame.to_bytes();
        let m = encode(&bytes).unwrap();
        let side = m.size;
        let mut gray = vec![255u8; side * side];
        for y in 0..side {
            for x in 0..side {
                if m.modules[y * side + x] {
                    gray[y * side + x] = 0;
                }
            }
        }
        let decoded = decode_from_gray(&gray, side, side, side, side).expect("gray decode");
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn side_for_5600() {
        let s = side_for_symbol_size(5600);
        assert!(s >= 200 && s <= 250);
    }

    /// 模拟真实相机：AFGrid 码只占画面中央一部分，周围是亮背景（环境光）。
    /// 验证投影法 L1 能定位并解码。
    #[test]
    fn gray_roundtrip_with_padding_background() {
        let sym = 512u32;
        let frame = Frame::build(1u128, 0, 0, 0, 1, 10, sym, 1, 0, &vec![0x42; sym as usize]);
        let bytes = frame.to_bytes();
        let m = encode(&bytes).unwrap();
        let code_side = m.size;
        // 把 AFGrid 嵌入一个更大的画面（四周留白 50% 宽度，模拟桌面背景）
        let canvas_side = code_side * 2;
        let offset = (canvas_side - code_side) / 2;
        let mut gray = vec![255u8; canvas_side * canvas_side]; // 全白背景
        for y in 0..code_side {
            for x in 0..code_side {
                if m.modules[y * code_side + x] {
                    gray[(offset + y) * canvas_side + (offset + x)] = 0;
                }
            }
        }
        let decoded = decode_from_gray(&gray, canvas_side, canvas_side, canvas_side, code_side)
            .expect("投影法应能定位嵌入背景的 AFGrid");
        assert_eq!(decoded, bytes);
    }
}
