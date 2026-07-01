//! Repro: certain files stick at "恢复中 0%" on the receiver.
//! Mirrors the Android receiver path exactly: bootstrap from the first frame's
//! header via derive_meta_from_totals + ReceiverSession::new (unconfirmed),
//! then feed the real wire stream (descriptor + data frames) through
//! Frame::to_bytes -> Frame::from_bytes -> ingest.

// This test deliberately exercises the deprecated heuristic to reproduce a
// historical bug path. The deprecation is intentional for everyone else; here
// we silence it so the diagnostic stays buildable.
#![allow(deprecated)]

use qr_protocol::{Frame, SessionId};
use raptorq_core::Config;
use transfer_engine::descriptor::FileMeta;
use transfer_engine::receiver::{derive_meta_from_totals, ReceiverSession};
use transfer_engine::sender::{SenderConfig, SenderSession};

/// High-entropy bytes, like an already-compressed PNG.
fn high_entropy(n: usize) -> Vec<u8> {
    let mut s: u64 = 0x9E3779B97F4A7C15;
    (0..n)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s & 0xff) as u8
        })
        .collect()
}

fn run_android_path(size: usize, redundancy: u8, label: &str) {
    let data = high_entropy(size);
    let sid = SessionId::derive("完整组图.png", size as u64, 0, &[]);
    let fm = FileMeta {
        filename: "完整组图.png".into(),
        original_size: size as u64,
        crc32: 0,
        compression: qr_protocol::compress::COMPRESSION_NONE,
        compressed_size: size as u64,
        compressed_size_known: true,
        crc32_known: false,
    };
    let mut sender = SenderSession::new(
        &data,
        sid,
        SenderConfig { codec: Config::default(), redundancy_pct: redundancy },
        fm,
    )
    .unwrap();

    let total_k = sender.total_k();
    let mut rx: Option<ReceiverSession> = None;

    let mut ingested = 0u32;
    let mut rejected = 0u32;
    let mut descriptor_ok = false;
    // Emit up to ~3 passes; stop on completion.
    let budget = (total_k as usize) * 4 + 200;
    for _ in 0..budget {
        let frame = match sender.next_frame() {
            Ok(f) => f,
            Err(e) => {
                rejected += 1;
                eprintln!("[{label}] next_frame ERR: {e}");
                continue;
            }
        };
        // Wire round-trip.
        let bytes = frame.to_bytes();
        let parsed = match Frame::from_bytes(&bytes) {
            Ok(p) => p,
            Err(e) => {
                rejected += 1;
                eprintln!("[{label}] from_bytes ERR: {e}");
                continue;
            }
        };
        // Android bootstraps the receiver from the first frame's header totals.
        if rx.is_none() {
            let meta = derive_meta_from_totals(
                parsed.header.total_blocks,
                parsed.header.total_symbols,
                parsed.header.symbol_size,
            );
            rx = Some(ReceiverSession::new(parsed.header.session_id, meta));
        }
        let r = rx.as_mut().unwrap();
        let _ = r.ingest(parsed);
        ingested += 1;
        if r.is_meta_confirmed() {
            descriptor_ok = true;
        }
        if r.is_complete() {
            break;
        }
    }

    let mut rx = rx.expect("receiver never created");
    let p = rx.progress();
    println!(
        "[{label}] size={size} K={total_k} ingested={ingested} rejected={rejected} \
         meta_confirmed={} received={} decoded={} decoded_blocks={}/{} complete={} frac={:.3}",
        descriptor_ok,
        p.received_symbols,
        p.decoded_symbols,
        p.decoded_blocks,
        p.total_blocks,
        rx.is_complete(),
        p.decoded_fraction()
    );

    assert!(rx.is_complete(), "[{label}] STUCK: never completed");
    let out = rx.assemble().expect("assemble failed");
    assert_eq!(&out[..size], &data[..], "[{label}] payload mismatch");
}

#[test]
#[ignore]
fn repro_small_works() {
    run_android_path(50_000, 10, "small-50k");
}

#[test]
#[ignore]
fn repro_1mb() {
    run_android_path(1_000_000, 10, "1mb");
}

#[test]
#[ignore]
fn repro_2mb_png_like() {
    run_android_path(2_430_754, 10, "2.4mb-png");
}
