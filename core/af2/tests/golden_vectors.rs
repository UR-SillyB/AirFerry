//! AF2 golden-vector verification test (Phase A1 / C1).
//!
//! Loads `core/testdata/af2/manifest.json`, validates its schema and integrity
//! against the Rust AF2 codecs, ensuring no drift between specification,
//! test fixtures, and live implementation across platforms.

use af2::frame::{Af2Frame, FrameType};
use af2::id::empty_hash;
use af2::meta::ObjectMetaRecord;
use af2::root::RootRecord;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn af2_golden_vectors_verify() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../testdata/af2");
    let manifest_path = dir.join("manifest.json");
    let raw = fs::read_to_string(&manifest_path).expect("manifest.json must exist");
    let v: Value = serde_json::from_str(&raw).expect("manifest.json must be valid JSON");

    // 1. BLAKE3 empty hash invariant
    let empty_h = hex(&empty_hash());
    assert_eq!(
        empty_h,
        v["blake3_empty_hash"].as_str().unwrap(),
        "BLAKE3 empty hash mismatch"
    );

    // 2. Three IDs check
    let cid_hex = v["three_ids"]["content_id_hex"].as_str().unwrap();
    let tid_hex = v["three_ids"]["transfer_id_hex"].as_str().unwrap();
    let oid_hex = v["three_ids"]["object_id_hex"].as_str().unwrap();
    assert_eq!(cid_hex.len(), 64);
    assert_eq!(tid_hex.len(), 32);
    assert_eq!(oid_hex.len(), 32);

    // 3. ROOT record & frame round-trip
    let root_bytes = unhex(v["root_record_hex"].as_str().unwrap());
    let root = RootRecord::parse(&root_bytes).expect("ROOT record must parse");
    assert_eq!(hex(&root.content_id), cid_hex);
    assert_eq!(hex(&root.transfer()), tid_hex);

    let root_frame_bytes = unhex(v["root_frame_hex"].as_str().unwrap());
    let root_frame = Af2Frame::from_bytes(&root_frame_bytes).expect("ROOT frame must parse");
    assert_eq!(root_frame.frame_type, FrameType::Root);
    assert_eq!(root_frame.object_id, root.transfer());

    // 4. OBJECT_META record & frame round-trip
    let meta_bytes = unhex(v["object_meta_record_hex"].as_str().unwrap());
    let meta = ObjectMetaRecord::parse(&meta_bytes).expect("OBJECT_META record must parse");
    assert_eq!(hex(&meta.recompute_object_id()), oid_hex);

    let meta_frame_bytes = unhex(v["object_meta_frame_hex"].as_str().unwrap());
    let meta_frame = Af2Frame::from_bytes(&meta_frame_bytes).expect("META frame must parse");
    assert_eq!(meta_frame.frame_type, FrameType::ObjectMeta);
    assert_eq!(hex(&meta_frame.object_id), oid_hex);

    // 5. SYMBOL frame round-trip
    let symbol_frame_bytes = unhex(v["symbol_frame_hex"].as_str().unwrap());
    let symbol_frame = Af2Frame::from_bytes(&symbol_frame_bytes).expect("SYMBOL frame must parse");
    assert_eq!(symbol_frame.frame_type, FrameType::Symbol);
    assert_eq!(hex(&symbol_frame.object_id), oid_hex);
    assert_eq!(symbol_frame.sbn, 1);
    assert_eq!(symbol_frame.esi, 42);
}
