//! End-to-end test driving the C ABI (`cffi`) exactly like the Windows P/Invoke
//! host will: create a handle, ingest QR frames, poll progress, and finally
//! assemble + free the recovered bytes. This guards the FFI contract the .NET
//! client depends on (packed status layout, assemble/free pairing, JSON).
//!
//! Only compiled under the `cffi` feature — mirrors how the Windows build
//! selects the binding.

#![cfg(feature = "cffi")]

use qr_protocol::SessionId;
use raptorq_core::Config;
use transfer_engine::sender::{SenderConfig, SenderSession};

// The C-ABI handle is an opaque pointer in the host; mirror that here by
// treating it as `*mut c_void` (the real pointee is `ReceiverSession`, which is
// an opaque implementation detail the host never inspects).
use std::ffi::c_void;

// Import the C-ABI symbols from the crate's own test build. They are
// `#[no_mangle] extern "C"`, so we extern-declare them by their exact names.
extern "C" {
    fn airferry_receiver_create(sid_lo: u64, sid_hi: u64) -> *mut c_void;
    fn airferry_receiver_destroy(handle: *mut c_void);
    fn airferry_receiver_ingest(
        handle: *mut c_void,
        frame_bytes: *const u8,
        frame_len: usize,
    ) -> u64;
    fn airferry_receiver_is_complete(handle: *const c_void) -> i32;
    fn airferry_receiver_assemble(
        handle: *const c_void,
        out_buf: *mut *mut u8,
        out_len: *mut usize,
    ) -> i32;
    fn airferry_buffer_free(ptr: *mut u8, len: usize);
    fn airferry_receiver_progress_json(
        handle: *const c_void,
        out: *mut u8,
        cap: usize,
    ) -> usize;
    fn airferry_receiver_file_name(
        handle: *const c_void,
        out: *mut u8,
        cap: usize,
    ) -> usize;
    fn airferry_receiver_file_size(handle: *const c_void) -> u64;
    fn airferry_receiver_crc32(handle: *const c_void) -> u64;
    fn airferry_receiver_crc32_known(handle: *const c_void) -> i32;
}

const INGEST_ERROR: u64 = 0xFFFF_FFFFu64 << 32;
const TEST_FILENAME: &str = "hello.txt";

fn pseudo_random(n: usize) -> Vec<u8> {
    (0..n).map(|i| ((i * 1103515245 + 12345) & 0xff) as u8).collect()
}

#[test]
fn cffi_end_to_end_recovery() {
    let data = pseudo_random(120_000); // spans several source blocks
    let sid = SessionId::derive("cffi-e2e", data.len() as u64, 0, &[]);
    let sid_u128: u128 = sid.into();

    // Probe the sender once to learn the padded transfer_length, then build the
    // real sender with a FileMeta whose compressed_size matches it and carries
    // a known filename + CRC. Mirrors what the browser sender emits.
    let probe = SenderSession::new(
        &data,
        sid,
        SenderConfig {
            codec: Config::default(),
            redundancy_pct: 25,
        },
        transfer_engine::FileMeta::default(),
    )
    .unwrap();
    let padded_len = probe.meta().transfer_length;
    let expected_crc = crc32_of(&data);
    let fm = transfer_engine::FileMeta {
        filename: TEST_FILENAME.to_string(),
        original_size: data.len() as u64,
        crc32: expected_crc,
        compression: qr_protocol::compress::COMPRESSION_NONE,
        compressed_size: padded_len,
        compressed_size_known: true,
        crc32_known: true,
    };
    let mut sender = SenderSession::new(
        &data,
        sid,
        SenderConfig {
            codec: Config::default(),
            redundancy_pct: 25,
        },
        fm,
    )
    .unwrap();
    sender.set_descriptor_interval(8);

    // Create the C-ABI receiver with the split session id (low + high u64),
    // exactly as the Windows host will.
    let handle =
        unsafe { airferry_receiver_create(sid_u128 as u64, (sid_u128 >> 64) as u64) };
    assert!(!handle.is_null());

    // Drain frames from the sender, round-tripping through the wire format,
    // and feed each one to the C ABI ingest path.
    let total_k = sender.total_k();
    let mut emitted = 0u32;
    for _ in 0..(total_k as usize * 3 + 64) {
        if unsafe { airferry_receiver_is_complete(handle) } != 0 {
            break;
        }
        let frame = sender.next_frame().unwrap();
        emitted += 1;
        let bytes = frame.to_bytes();
        let status = unsafe { airferry_receiver_ingest(handle, bytes.as_ptr(), bytes.len()) };
        // Any frame that's well-formed must NOT return the error sentinel.
        assert_ne!(status, INGEST_ERROR, "well-formed frame rejected");
    }
    assert_eq!(
        unsafe { airferry_receiver_is_complete(handle) },
        1,
        "must be complete after emitting {} frames",
        emitted
    );

    // Poll progress JSON via the two-pass length protocol a Windows host uses.
    let needed = unsafe { airferry_receiver_progress_json(handle, std::ptr::null_mut(), 0) };
    assert!(needed > 1, "progress JSON must be non-empty");
    let mut json_buf = vec![0u8; needed];
    let written =
        unsafe { airferry_receiver_progress_json(handle, json_buf.as_mut_ptr(), json_buf.len()) };
    assert_eq!(written, needed);
    let json = std::str::from_utf8(&json_buf[..needed - 1]).unwrap();
    assert!(json.contains("\"complete\":true"), "json={json}");
    assert!(json.contains("\"meta_confirmed\":true"), "json={json}");

    // File metadata accessors.
    let name_needed = unsafe { airferry_receiver_file_name(handle, std::ptr::null_mut(), 0) };
    let mut name_buf = vec![0u8; name_needed];
    unsafe { airferry_receiver_file_name(handle, name_buf.as_mut_ptr(), name_buf.len()) };
    let name = std::str::from_utf8(&name_buf[..name_needed - 1]).unwrap();
    assert_eq!(name, TEST_FILENAME);
    assert_eq!(
        unsafe { airferry_receiver_file_size(handle) },
        data.len() as u64
    );
    assert_eq!(
        unsafe { airferry_receiver_crc32(handle) },
        expected_crc as u64
    );
    assert_eq!(unsafe { airferry_receiver_crc32_known(handle) }, 1);

    // Assemble the recovered bytes (Rust allocates; host frees).
    let mut out_buf: *mut u8 = std::ptr::null_mut();
    let mut out_len: usize = 0;
    let ok =
        unsafe { airferry_receiver_assemble(handle, &mut out_buf, &mut out_len) };
    assert_eq!(ok, 1, "assemble must succeed once complete");
    assert!(!out_buf.is_null());
    // RaptorQ zero-pads to a symbol boundary; trim back to the descriptor's
    // original_size (exactly what Android's recoverAndStage does).
    let original = unsafe { airferry_receiver_file_size(handle) } as usize;
    assert!(
        out_len >= original,
        "assembled {} < original {}",
        out_len,
        original
    );
    // SAFETY: out_buf[..out_len] is the recovered file bytes.
    let recovered = unsafe { std::slice::from_raw_parts(out_buf, original) };
    assert_eq!(recovered, data.as_slice(), "recovered bytes must match");
    // The trailing pad region (if any) must be all zero, like Android checks.
    let pad = unsafe { std::slice::from_raw_parts(out_buf.add(original), out_len - original) };
    assert!(pad.iter().all(|&b| b == 0), "trailing pad must be zero");
    // Release the Rust allocation.
    unsafe { airferry_buffer_free(out_buf, out_len) };

    // Final teardown.
    unsafe { airferry_receiver_destroy(handle) };
}

/// Simple table-driven CRC32, matching what the sender computes. Used only to
/// verify the receiver reports the same CRC the host would compute locally.
fn crc32_of(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for i in 0..256u32 {
        let mut c = i;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
        }
        table[i as usize] = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = (crc >> 8) ^ table[((crc ^ b as u32) & 0xFF) as usize];
    }
    crc ^ 0xFFFF_FFFFu32
}
