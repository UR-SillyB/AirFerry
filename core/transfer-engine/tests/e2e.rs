//! End-to-end integration test: late-join receiver recovers a multi-block
//! object purely from the QR frame stream (descriptor + data frames),
//! including simulated loss, duplication, and out-of-order delivery.

use qr_protocol::{Frame, SessionId};
use raptorq_core::Config;
use transfer_engine::receiver::ReceiverSession;
use transfer_engine::sender::{SenderConfig, SenderSession};

fn pseudo_random(n: usize) -> Vec<u8> {
    (0..n).map(|i| ((i * 1103515245 + 12345) & 0xff) as u8).collect()
}

/// Drive a full send → receive cycle. The receiver is bootstrapped from the
/// FIRST frame it sees (which may be a descriptor or a data frame), exercising
/// the late-join path rather than the sender handing over its OTI directly.
fn cycle(data: &[u8], redundancy: u8, drop_every: u32, dup_some: bool, shuffle: bool) {
    let sid = SessionId::derive("file", data.len() as u64, 0, &[]);
    // Probe the sender once to learn the padded transfer_length, then build the
    // real sender with a FileMeta whose compressed_size matches it. Without
    // this the descriptor would advertise compressed_size=0 and the receiver
    // would trim the recovered object to zero bytes.
    let probe = SenderSession::new(
        data,
        sid,
        SenderConfig {
            codec: Config::default(),
            redundancy_pct: redundancy,
        },
        transfer_engine::FileMeta::default(),
    )
    .unwrap();
    let padded_len = probe.meta().transfer_length;
    let fm = transfer_engine::FileMeta {
        filename: String::new(),
        original_size: data.len() as u64,
        crc32: 0,
        compression: qr_protocol::compress::COMPRESSION_NONE,
        compressed_size: padded_len,
        compressed_size_known: true,
        crc32_known: false,
    };
    let mut sender = SenderSession::new(
        data,
        sid,
        SenderConfig {
            codec: Config::default(),
            redundancy_pct: redundancy,
        },
        fm,
    )
    .unwrap();
    // Emit a descriptor early so the receiver learns the real layout fast.
    sender.set_descriptor_interval(8);

    // Collect a large batch of frames (with optional loss / dup / shuffle).
    let total_k = sender.total_k();
    let batch = (total_k as usize) * 3 + 64;
    let mut frames: Vec<Frame> = Vec::new();
    for i in 0..batch {
        let f = sender.next_frame().unwrap();
        if drop_every > 0 && (i as u32) % drop_every == 0 {
            continue;
        }
        frames.push(f);
    }
    if dup_some {
        let extra = frames.iter().take(7).cloned().collect::<Vec<_>>();
        frames.extend(extra);
    }
    if shuffle {
        for i in (1..frames.len()).rev() {
            let j = (i as u32).wrapping_mul(2654435761) as usize % (i + 1);
            frames.swap(i, j);
        }
    }

    // Receiver bootstraps from the first frame it observes.
    let mut rx: Option<ReceiverSession> = None;
    for f in frames {
        // Force the wire round-trip (pack/unpack + double CRC).
        let bytes = f.to_bytes();
        let parsed = match Frame::from_bytes(&bytes) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if rx.is_none() {
            rx = Some(ReceiverSession::from_first_frame(&parsed));
        }
        let _ = rx.as_mut().unwrap().ingest(parsed);
        if rx.as_ref().unwrap().is_complete() {
            break;
        }
    }

    let rx = rx.expect("receiver never created");
    assert!(rx.is_complete(), "failed to recover object");
    let out = rx.assemble().unwrap();
    assert!(out.len() >= data.len());
    assert_eq!(&out[..data.len()], data, "recovered payload must match");
    let p = rx.progress();
    assert!(p.decoded_fraction() >= 1.0);
}

#[test]
fn e2e_multiblock_no_loss() {
    let data = pseudo_random(120_000); // spans several source blocks
    cycle(&data, 10, 0, false, false);
}

#[test]
fn e2e_multiblock_20pct_loss_dup_shuffle() {
    let data = pseudo_random(90_000);
    cycle(&data, 40, 5, true, true);
}

#[test]
fn e2e_tiny_file() {
    let data = pseudo_random(100);
    cycle(&data, 10, 0, false, false);
}
