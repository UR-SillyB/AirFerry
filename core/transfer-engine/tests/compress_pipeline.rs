//! End-to-end test for the compressed-payload pipeline.
//!
//! Compresses a payload with Zstd, sends it through the full RaptorQ +
//! descriptor-frame path, and verifies the receiver recovers the ORIGINAL
//! (decompressed) bytes from `assemble()`. Exercises every v3 field the
//! descriptor carries (compression tag + compressed_size).

use qr_protocol::{compress, Frame, SessionId};
use raptorq_core::Config;
use transfer_engine::descriptor::FileMeta;
use transfer_engine::receiver::ReceiverSession;
use transfer_engine::sender::{SenderConfig, SenderSession};

fn pseudo_random(n: usize) -> Vec<u8> {
    // Text-like, highly compressible content (repeating patterns).
    (0..n)
        .map(|i| b"ABCDEFGHabcdefgh0123456789\n"[i % 27])
        .collect()
}

#[test]
fn zstd_pipeline_recovers_original_bytes() {
    let original = pseudo_random(40_000);
    let compressed = compress::compress_with(&original, compress::COMPRESSION_ZSTD).unwrap();
    // Sanity: the test data really is compressible.
    assert!(compressed.len() < original.len());

    let fm = FileMeta {
        filename: "data.txt".into(),
        original_size: original.len() as u64,
        crc32: 0,
        compression: compress::COMPRESSION_ZSTD,
        compressed_size: compressed.len() as u64,
        compressed_size_known: true,
        crc32_known: false,
    };
    let mut sender = SenderSession::new(
        &compressed,
        SessionId::zero(),
        SenderConfig {
            codec: Config::default(),
            redundancy_pct: 10,
        },
        fm,
    )
    .unwrap();
    sender.set_descriptor_interval(5);

    // Bootstrap the receiver from the first (descriptor) frame so it learns
    // the v3 file_meta, then feed the rest.
    let mut rx = None;
    let total_k = sender.total_k();
    for _ in 0..(total_k as usize * 3 + 32) {
        let f = sender.next_frame().unwrap();
        let parsed = Frame::from_bytes(&f.to_bytes()).unwrap();
        if rx.is_none() {
            rx = Some(ReceiverSession::from_first_frame(&parsed));
        }
        rx.as_mut().unwrap().ingest(parsed).unwrap();
        if rx.as_ref().unwrap().is_complete() {
            break;
        }
    }
    let mut rx = rx.unwrap();
    assert!(rx.is_complete(), "receiver should recover all symbols");
    assert_eq!(
        rx.file_meta().compression,
        compress::COMPRESSION_ZSTD,
        "descriptor must advertise Zstd"
    );

    // The headline assertion: assemble() returns the ORIGINAL uncompressed
    // bytes, not the compressed payload and not the symbol-padded bytes.
    let recovered = rx.assemble().expect("assemble must succeed");
    assert_eq!(recovered, original, "assemble() must return original bytes");
    assert_eq!(
        recovered.len(),
        original.len(),
        "no trailing zero padding should leak through"
    );
}

#[test]
fn uncompressed_pipeline_still_works() {
    // Regression guard: a v3 descriptor tagged COMPRESSION_NONE must behave
    // exactly like the legacy path (return the transmitted bytes trimmed to
    // compressed_size == original_size).
    let original = pseudo_random(20_000);
    let fm = FileMeta {
        filename: "raw.bin".into(),
        original_size: original.len() as u64,
        crc32: 0,
        compression: compress::COMPRESSION_NONE,
        compressed_size: original.len() as u64,
        compressed_size_known: true,
        crc32_known: false,
    };
    let mut sender =
        SenderSession::new(&original, SessionId::zero(), SenderConfig::default(), fm).unwrap();
    sender.set_descriptor_interval(5);

    let mut rx = None;
    let total_k = sender.total_k();
    for _ in 0..(total_k as usize * 3 + 32) {
        let f = sender.next_frame().unwrap();
        let parsed = Frame::from_bytes(&f.to_bytes()).unwrap();
        if rx.is_none() {
            rx = Some(ReceiverSession::from_first_frame(&parsed));
        }
        rx.as_mut().unwrap().ingest(parsed).unwrap();
        if rx.as_ref().unwrap().is_complete() {
            break;
        }
    }
    let mut rx = rx.unwrap();
    let recovered = rx.assemble().unwrap();
    assert_eq!(recovered, original);
}
