//! AFGrid encode (sender path) + module decode (receiver path) integration.

use qr_protocol::Frame;
use qr_protocol::afgrid;
use transfer_engine::matrix_encode::encode_frame_matrix;

#[test]
fn afgrid_matrix_encode_roundtrip_5600() {
    let sym = 5600u32;
    let frame = Frame::build(
        9u128,
        0,
        2,
        3,
        1,
        100,
        sym,
        42,
        0,
        &vec![0x11; sym as usize],
    );
    let bytes = frame.to_bytes();
    let m = encode_frame_matrix(&bytes).expect("encode");
    let mods: Vec<u8> = m.modules.iter().map(|&b| b as u8).collect();
    let back = afgrid::decode_from_modules(&mods, m.size).expect("decode");
    assert_eq!(back, bytes);
    let side = afgrid::side_for_symbol_size(sym);
    assert_eq!(m.size, side);
}
