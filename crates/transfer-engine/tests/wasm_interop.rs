//! Cross-language interop test: frames produced by the WASM sender (Node) are
//! fed into the native Rust receiver, and recovery is verified byte-for-byte
//! against the original payload.
//!
//! Prerequisite: run the dumper first:
//!   node crates/transfer-engine/scripts/wasm_dump_frames.mjs 200000
//!
//! Then: cargo test -p transfer-engine --test wasm_interop

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use transfer_engine::receiver::ReceiverSession;
use transfer_engine::descriptor;

fn script_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts")
}

/// Read the frame dump produced by wasm_dump_frames.mjs.
fn read_dump() -> Option<(Vec<Vec<u8>>, Vec<u8>)> {
    let dir = script_dir();
    let frames_path = dir.join("frames.bin");
    let payload_path = dir.join("payload.bin");
    if !frames_path.exists() || !payload_path.exists() {
        return None;
    }
    let frames_bytes = fs::read(&frames_path).unwrap();
    let payload = fs::read(&payload_path).unwrap();
    let mut off = 0usize;
    let read_u32 = |b: &[u8], o: &mut usize| -> u32 {
        let v = u32::from_be_bytes([b[*o], b[*o + 1], b[*o + 2], b[*o + 3]]);
        *o += 4;
        v
    };
    let count = read_u32(&frames_bytes, &mut off);
    let mut frames = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let len = read_u32(&frames_bytes, &mut off) as usize;
        frames.push(frames_bytes[off..off + len].to_vec());
        off += len;
    }
    Some((frames, payload))
}

#[test]
fn wasm_frames_recover_in_native_receiver() {
    let (frames, payload) = match read_dump() {
        Some(v) => v,
        None => {
            eprintln!(
                "[skip] frames.bin/payload.bin not found. Run:\n  \
                 node crates/transfer-engine/scripts/wasm_dump_frames.mjs 200000"
            );
            return;
        }
    };
    assert!(!frames.is_empty(), "dump produced no frames");

    // Buffer parsed frames until we see a descriptor (which carries the
    // authoritative per-block layout). Then build the receiver from the
    // descriptor's OTI and replay all frames in order. This mirrors the
    // real receiver: it waits for the OTI before it can decode multi-block.
    let mut parsed: Vec<transfer_engine::Frame> = Vec::new();
    let mut meta_opt: Option<transfer_engine::DescriptorInfo> = None;
    let mut session_id: u128 = 0;

    for bytes in &frames {
        if let Ok(frame) = transfer_engine::qr_protocol_frame_from_bytes(bytes) {
            session_id = frame.header.session_id;
            if frame.header.flags & transfer_engine::FLAG_DESCRIPTOR_BIT != 0 {
                if let Some(info) = descriptor::parse_payload(&frame.payload) {
                    meta_opt = Some(info);
                }
            } else {
                parsed.push(frame);
            }
        }
    }

    let info = meta_opt.expect("no descriptor frame observed in the dump");
    let mut rx = ReceiverSession::new_confirmed(session_id, info.meta);

    let mut seen: HashSet<(u32, u32)> = HashSet::new();
    let mut ingested = 0usize;
    for frame in parsed {
        let key = (frame.header.sbn, frame.header.esi);
        if seen.insert(key) {
            let _ = rx.ingest(frame);
            ingested += 1;
        }
        if rx.is_complete() {
            break;
        }
    }

    assert!(rx.is_complete(), "receiver failed to recover");
    let out = rx.assemble().expect("assembled");
    assert!(out.len() >= payload.len());
    assert_eq!(&out[..payload.len()], &payload[..], "payload mismatch");
    println!(
        "✅ recovered {}B from {} WASM-produced frames ({} unique ingested)",
        payload.len(),
        frames.len(),
        ingested
    );
}
