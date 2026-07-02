//! AFGrid vs QR encode benchmark (ignored by default).

use qr_protocol::Frame;
use qr_protocol::afgrid;
use qr_protocol::qr_render;
use std::time::Instant;

fn sample_frame(symbol_size: u32) -> Vec<u8> {
    let frame = Frame::build(
        1u128,
        0,
        1,
        1,
        1,
        10,
        symbol_size,
        1,
        0,
        &vec![0xCD; symbol_size as usize],
    );
    frame.to_bytes()
}

#[test]
#[ignore]
fn bench_afgrid_vs_qr_5600() {
    let bytes_5600 = sample_frame(5600);
    let bytes_1400 = sample_frame(1400);
    let n = 200u32;
    let t0 = Instant::now();
    for _ in 0..n {
        let _ = afgrid::encode(&bytes_5600).unwrap();
    }
    let af = t0.elapsed().as_secs_f64() / n as f64;
    let t1 = Instant::now();
    for _ in 0..4 * n {
        let _ = qr_render::encode(&bytes_1400).unwrap();
    }
    let qr4 = t1.elapsed().as_secs_f64() / (4 * n) as f64;
    println!(
        "1x AFGrid@5600 {:.4}ms vs 4x QR@1400 {:.4}ms per screen tick",
        af * 1000.0,
        qr4 * 1000.0
    );
    assert!(af < qr4 * 3.0, "AFGrid single tick should beat 4x QR encode");
}

#[test]
fn afgrid_encode_smoke() {
    let bytes = sample_frame(512);
    let m = afgrid::encode(&bytes).unwrap();
    assert!(m.size > 10);
}
