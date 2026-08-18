//! C ABI bindings for the receiver side (Windows / .NET P/Invoke).
//!
//! Mirrors [`jni`] (Android) but exposes a plain C ABI so any C-compatible
//! host — C# P/Invoke, C/C++, Python ctypes — can drive a receive session
//! without the JVM. Used by the AirFerry Windows client
//! (`apps/windows/AirFerry.Windows`).
//!
//! ## Handle model
//! A receiver session is heap-allocated (`Box<ReceiverSession>`), and its raw
//! pointer is returned to the caller as an opaque `*mut`. Every function takes
//! that handle back as its first argument; pass null to release it via
//! [`airferry_receiver_destroy`]. The pointer is *not* thread-safe — the host
//! must serialize all calls that touch the same handle (the Windows client
//! does this with a single ingest lock, exactly like Android's `ingestLock`).
//!
//! ## Memory ownership
//! - Strings/byte buffers returned by value (e.g. [`airferry_receiver_ingest`]'s
//!   status word) are copied and need no cleanup.
//! - [`airferry_receiver_assemble`] returns a Rust-allocated buffer + length;
//!   the caller must copy the bytes out and then call [`airferry_buffer_free`]
//!   on the pointer to release Rust's allocation. Never `free` it from the host.
//! - `*_into_buffer` functions (progress JSON, file name) take a caller-owned
//!   buffer + capacity and return the number of bytes written (or, when the
//!   buffer is null/too small, the required length so the caller can
//!   re-allocate and retry). No Rust-side allocation crosses the boundary.

#![cfg(feature = "cffi")]

use crate::ingest_status;
use crate::receiver::ReceiverSession;
use crate::Progress;
use raptorq_core::MAX_ORIGINAL_BYTES;
use std::os::raw::c_char;

// Per-frame status packing + the error sentinel now live in the shared
// [`ingest_status`] module so the JNI, C ABI, and WASM bindings cannot drift
// from the wire contract (bit layout documented there).

/// ABI / capability version of this C ABI library, mirroring the Android-side
/// `AIRFERRY_NATIVE_ABI_VERSION` handshake.
///
/// - 1: legacy v1 (pre-AF2) segmented receive path.
/// - 2: the 16 per-field receiver getters were replaced by the single
///   [`airferry_receiver_snapshot_json`] (`ReceiverSnapshotV2`).
/// - 3: bounded-memory incremental §13 final verification was added.
///
/// The Windows host (`NativeBridge.NativeAbiVersion`) must verify this at
/// startup and refuse to run against an older DLL.
pub const AIRFERRY_NATIVE_ABI_VERSION: u32 = 3;

/// Report the native ABI / capability version ([`AIRFERRY_NATIVE_ABI_VERSION`]).
#[no_mangle]
pub extern "C" fn airferry_native_abi_version() -> u32 {
    AIRFERRY_NATIVE_ABI_VERSION
}

/// Create a "cache-only" receiver. `sid_lo`/`sid_hi` split the 128-bit session
/// id into its low/high 64-bit halves (host order). As on Android, no object
/// metadata is built from the totals yet — data frames are buffered until the
/// first validated descriptor frame supplies the authoritative OTI. Returns a
/// non-null opaque handle on success.
#[no_mangle]
pub extern "C" fn airferry_receiver_create(sid_lo: u64, sid_hi: u64) -> *mut ReceiverSession {
    let sid: u128 = ((sid_hi as u128) << 64) | (sid_lo as u128);
    let session = ReceiverSession::new_pending(sid);
    Box::into_raw(Box::new(session))
}

/// Destroy a receiver created by [`airferry_receiver_create`]. Passing null is
/// a no-op. After this returns, the handle is invalid and must not be reused.
///
/// # Safety
/// `handle` must be null or a live handle returned by create, exclusively owned
/// by the caller, and it must never be used again after this call.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_destroy(handle: *mut ReceiverSession) {
    if handle.is_null() {
        return;
    }
    // SAFETY: the caller obtained `handle` from `airferry_receiver_create` and
    // guarantees no other thread is accessing it (host-side serialization).
    unsafe {
        drop(Box::from_raw(handle));
    }
}

/// Ingest one decoded QR payload (`frame_bytes`, `frame_len` bytes).
///
/// Returns a packed 64-bit status word with the same bit layout as the JNI
/// binding (all fields unsigned):
///   - bit  0      : `complete` (1 once the object is fully decoded)
///   - bit  1      : `accepted` (1 if this frame contributed a new symbol)
///   - bits 8..23  : `session_mismatch_streak` (0..=0xFFFF)
///   - bits 32..63 : `received_symbols` (low 32 bits)
///
/// Returns [`ingest_status::INGEST_ERROR`] (`received_symbols == u32::MAX`) on a null handle or
/// a frame that fails wire validation (bad magic / CRC / version); the host
/// treats this as "frame rejected, nothing to do".
///
/// # Safety
/// `handle` must be a live, exclusively borrowed receiver and `frame_bytes`
/// must point to `frame_len` readable bytes for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_ingest(
    handle: *mut ReceiverSession,
    frame_bytes: *const u8,
    frame_len: usize,
) -> u64 {
    if handle.is_null() {
        return ingest_status::INGEST_ERROR;
    }
    // SAFETY: caller guarantees `frame_bytes[..frame_len]` is a valid borrowed
    // slice for the duration of this call.
    let slice: &[u8] = if frame_bytes.is_null() || frame_len == 0 {
        return ingest_status::INGEST_ERROR;
    } else {
        unsafe { std::slice::from_raw_parts(frame_bytes, frame_len) }
    };
    // SAFETY: caller guarantees `handle` is valid and not concurrently mutated.
    let session = unsafe { &mut *handle };
    session.ingest(slice)
}

/// Return 1 if the object is fully decoded, 0 otherwise (including a null
/// handle).
///
/// # Safety
/// A non-null `handle` must refer to a live receiver and must not be mutated
/// concurrently for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_is_complete(handle: *const ReceiverSession) -> i32 {
    if handle.is_null() {
        return 0;
    }
    // SAFETY: shared borrow; caller guarantees the handle is valid.
    let session = unsafe { &*handle };
    session.is_complete() as i32
}

/// Reassemble the recovered file into a freshly-allocated Rust buffer.
///
/// On success: writes the buffer pointer into `*out_buf` and its byte length
/// into `*out_len`, and returns 1. The caller MUST release the buffer with
/// [`airferry_buffer_free`] once it has copied the bytes out. Returns 0 (and
/// leaves `*out_buf` null) if the session is not yet complete, the handle is
/// null, or the bytes could not be decoded/decompressed.
///
/// This single-call contract replaces the JNI-era two-step `length` + `fill`
/// pattern (which raced on large files); see [`ReceiverSession::assemble_result`]
/// for the decompression semantics.
///
/// # Safety
/// `handle` must be live and exclusively borrowed. Non-null out parameters must
/// be writable. The returned buffer must be freed exactly once with its length.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_assemble(
    handle: *mut ReceiverSession,
    out_buf: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    if out_buf.is_null() || out_len.is_null() {
        return 0;
    }
    // SAFETY: both output pointers were checked and the caller guarantees they
    // are writable. Initialize them before every failure path.
    unsafe {
        *out_buf = std::ptr::null_mut();
        *out_len = 0;
    }
    if handle.is_null() {
        return 0;
    }
    // SAFETY: shared borrow; caller guarantees the handle is valid.
    let session = unsafe { &*handle };
    let data = match session.assemble_all() {
        Some(d) => d,
        None => return 0,
    };
    let len = data.len();
    let ptr = Box::into_raw(data.into_boxed_slice()) as *mut u8;
    // SAFETY: `out_buf`/`out_len` are caller-provided out-params; writing to
    // them is the documented contract.
    unsafe {
        *out_buf = ptr;
        *out_len = len;
    }
    1
}

/// Release a buffer returned by [`airferry_receiver_assemble`]. `ptr`/`len`
/// must be exactly the values the assemble call wrote. Passing null/0 is a
/// no-op. Do NOT call this on any pointer the host allocated itself.
///
/// # Safety
/// A non-null `ptr` and `len` must be the exact, still-owned pair returned by
/// `airferry_receiver_assemble`, and may be freed only once.
#[no_mangle]
pub unsafe extern "C" fn airferry_buffer_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: `ptr` came from `Box::into_raw(slice.into_boxed_slice())` in
    // `airferry_receiver_assemble`, with the same `len`. Reconstruct the slice
    // and drop it to free the allocation.
    unsafe {
        let slice = std::slice::from_raw_parts_mut(ptr, len);
        let _ = Box::from_raw(slice as *mut [u8]);
    }
}

/// Reassemble chunk `index` into a freshly-allocated Rust buffer. Free with
/// [`airferry_buffer_free`].
///
/// # Safety
/// `handle` must be null or a live receiver created by
/// [`airferry_receiver_create`], externally serialized against other calls.
/// `out_buf`/`out_len` must be null or valid for writes. On success the
/// returned buffer must be freed exactly once via [`airferry_buffer_free`].
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_assemble_chunk(
    handle: *mut ReceiverSession,
    index: u32,
    out_buf: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    if out_buf.is_null() || out_len.is_null() {
        return 0;
    }
    unsafe {
        *out_buf = std::ptr::null_mut();
        *out_len = 0;
    }
    if handle.is_null() {
        return 0;
    }
    let session = unsafe { &mut *handle };
    let Some(data) = session.assemble_chunk(index) else {
        return 0;
    };
    let len = data.len();
    let ptr = Box::into_raw(data.into_boxed_slice()) as *mut u8;
    unsafe {
        *out_buf = ptr;
        *out_len = len;
    }
    1
}

/// Index of the chunk completed by the most recent ChunkReady frame, or -1.
/// The host persists that chunk via [`airferry_receiver_assemble_chunk`] and
/// forgets it via [`airferry_receiver_forget_chunk`] to keep native memory
/// bounded by one chunk instead of the whole object.
///
/// # Safety
/// `handle` must be null or a live receiver created by
/// [`airferry_receiver_create`], externally serialized against other calls.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_last_chunk_index(
    handle: *const ReceiverSession,
) -> i32 {
    if handle.is_null() {
        return -1;
    }
    let session = unsafe { &*handle };
    session.last_completed_chunk_index().map(|i| i as i32).unwrap_or(-1)
}

/// Release a persisted chunk from native memory (eviction). Returns 1 when the
/// chunk was resident, 0 otherwise. Completion tracking is unaffected — the
/// ledger counts every ChunkReady, not what is still resident.
///
/// # Safety
/// `handle` must be null or a live receiver created by
/// [`airferry_receiver_create`], externally serialized against other calls.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_forget_chunk(
    handle: *mut ReceiverSession,
    index: u32,
) -> i32 {
    if handle.is_null() {
        return 0;
    }
    let session = unsafe { &mut *handle };
    session.forget_chunk(index) as i32
}

/// Decompress a caller-provided byte buffer according to a compression tag
/// (0=None, 1=Zstd, 2=Xz), bounded by `max_output` bytes. Used by the host to
/// decompress the concatenated compressed stream of a segmented transfer once.
///
/// Returns 1 on success (with a Rust-allocated buffer + length to free via
/// [`airferry_buffer_free`]) or 0 on failure / empty output.
///
/// # Safety
/// `data`/`data_len` must describe a valid, readable byte slice for the call
/// duration; `out_buf`/`out_len` must be writable out-params.
#[no_mangle]
pub unsafe extern "C" fn airferry_decompress_bytes(
    data: *const u8,
    data_len: usize,
    compression: u8,
    max_output: u64,
    out_buf: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    if out_buf.is_null() || out_len.is_null() {
        return 0;
    }
    unsafe {
        *out_buf = std::ptr::null_mut();
        *out_len = 0;
    }
    if data.is_null() || data_len == 0 {
        return 0;
    }
    let input = unsafe { std::slice::from_raw_parts(data, data_len) };
    // Clamp the host-supplied cap to MAX_ORIGINAL_BYTES so a careless or
    // hostile caller cannot disable decompress_with_limit's bomb bound by
    // passing a huge / usize::MAX-equivalent max_output.
    let cap = (max_output.min(MAX_ORIGINAL_BYTES)) as usize;
    let out = match qr_protocol::compress::decompress_with_limit(input, compression, cap) {
        Ok(bytes) => bytes,
        Err(e) => {
            cffi_log(&format!("decompress_bytes failed: {e}"));
            return 0;
        }
    };
    if out.is_empty() {
        return 0;
    }
    let len = out.len();
    let ptr = Box::into_raw(out.into_boxed_slice()) as *mut u8;
    unsafe {
        *out_buf = ptr;
        *out_len = len;
    }
    1
}

/// Stream a concatenated compressed stream from `input_path` to `output_path`,
/// decompressing as it goes while computing CRC32 + SHA-256 incrementally
/// (bounded RAM for very large files). Verifies decompressed size, CRC32 (when
/// known) and SHA-256 before returning 1; any mismatch or I/O error removes the
/// partial output and returns 0.
///
/// `max_output` caps the decompressed size (decompression-bomb guard).
///
/// # Safety
/// `input_path`/`output_path`/`expected_sha_hex` must be valid NUL-terminated
/// C strings for the call duration.
#[no_mangle]
pub unsafe extern "C" fn airferry_decompress_stream_to_file(
    input_path: *const c_char,
    output_path: *const c_char,
    compression: u8,
    max_output: u64,
    expected_size: u64,
    expected_crc: u32,
    crc_known: bool,
    expected_sha_hex: *const c_char,
) -> i32 {
    fn cstr(ptr: *const c_char) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        // SAFETY: caller guarantees NUL-terminated C strings.
        let bytes = unsafe { std::ffi::CStr::from_ptr(ptr) }.to_bytes();
        Some(String::from_utf8_lossy(bytes).into_owned())
    }
    let (Some(input), Some(output), Some(expected_sha)) =
        (cstr(input_path), cstr(output_path), cstr(expected_sha_hex))
    else {
        cffi_log("decompress_stream_to_file: missing argument");
        return 0;
    };
    let outcome = match qr_protocol::compress::decompress_stream_to_file(
        &input,
        &output,
        compression,
        max_output,
    ) {
        Ok(o) => o,
        Err(e) => {
            cffi_log(&format!("decompress_stream_to_file failed: {e}"));
            return 0;
        }
    };
    if outcome.output_size != expected_size {
        cffi_log(&format!(
            "decompress_stream_to_file size mismatch: {} != {}",
            outcome.output_size, expected_size
        ));
        let _ = std::fs::remove_file(&output);
        return 0;
    }
    if crc_known && outcome.crc32 != expected_crc {
        cffi_log(&format!(
            "decompress_stream_to_file crc mismatch: {:08x} != {:08x}",
            outcome.crc32, expected_crc
        ));
        let _ = std::fs::remove_file(&output);
        return 0;
    }
    let actual_sha: String = outcome.sha256.iter().map(|b| format!("{b:02x}")).collect();
    if !actual_sha.eq_ignore_ascii_case(&expected_sha) {
        cffi_log("decompress_stream_to_file sha mismatch");
        let _ = std::fs::remove_file(&output);
        return 0;
    }
    1
}

/// Write the NUL-terminated progress JSON into the caller-owned `out` buffer.
///
/// - If `out` is null or `cap` is smaller than needed, writes nothing and
///   returns the required length (including the trailing NUL). The host can
///   then allocate that many bytes and call again.
/// - Otherwise writes the JSON + NUL terminator and returns the number of
///   bytes written.
///
/// On a null handle, returns 0 (nothing to write).
///
/// # Safety
/// A non-null handle must be live. A non-null `out` must point to `cap`
/// writable bytes and must not overlap receiver storage.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_progress_json(
    handle: *const ReceiverSession,
    out: *mut u8,
    cap: usize,
) -> usize {
    if handle.is_null() {
        return 0;
    }
    let session = unsafe { &*handle };
    let json = progress_json(&session.progress());
    write_cstr(&json, out, cap)
}

/// Single-JSON receiver snapshot (`ReceiverSnapshotV2`, see
/// [`ReceiverSession::snapshot_json`]).
///
/// Replaces the former 16 per-field getters (compression / compressed_size /
/// original_size / file_name / file_size / crc32 / crc32_known / is_segmented
/// / segment_index / segment_count / root_original_size / original_offset /
/// root_session_id_lo/hi / raw_sha256 / root_sha256): one call returns every
/// AF2 snapshot field atomically, with no torn reads across getters.
///
/// Returns a Rust-allocated, NUL-terminated UTF-8 `char*` that the caller must
/// release with [`airferry_free_string`] (never `free` it from the host).
/// Returns null on a null handle.
///
/// # Safety
/// A non-null handle must refer to a live receiver and be externally
/// serialized (the same serialization that guards `airferry_receiver_ingest`).
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_snapshot_json(
    handle: *const ReceiverSession,
) -> *mut c_char {
    if handle.is_null() {
        return std::ptr::null_mut();
    }
    let session = unsafe { &*handle };
    // A CString conversion only fails on interior NULs, which the JSON
    // escaping in snapshot_json rules out; fall back to null defensively.
    match std::ffi::CString::new(session.snapshot_json()) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Verify a staged raw chunk against the ROOT-bound Manifest chunk table (§11).
/// Returns 1 on match, 0 on mismatch / manifest not ready yet.
///
/// # Safety
/// `handle` must be null or a live receiver created by
/// [`airferry_receiver_create`], externally serialized against other calls.
/// `raw_ptr` must be null or valid for reads of `raw_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_verify_chunk(
    handle: *const ReceiverSession,
    index: u32,
    raw_ptr: *const u8,
    raw_len: usize,
) -> i32 {
    if handle.is_null() || (raw_ptr.is_null() && raw_len != 0) {
        return 0;
    }
    let session = unsafe { &*handle };
    let slice = if raw_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(raw_ptr, raw_len) }
    };
    if session.verify_chunk(index, slice) { 1 } else { 0 }
}

/// Run §13 ⑧⑨ integrity chain over the reassembled canonical stream.
/// Returns 1 on success, 0 on any verification failure.
///
/// # Safety
/// `handle` must be null or a live receiver created by
/// [`airferry_receiver_create`], externally serialized against other calls.
/// `stream_ptr` must be null or valid for reads of `stream_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_verify_final_stream(
    handle: *const ReceiverSession,
    stream_ptr: *const u8,
    stream_len: usize,
) -> i32 {
    if handle.is_null() || (stream_ptr.is_null() && stream_len != 0) {
        return 0;
    }
    let session = unsafe { &*handle };
    let slice = if stream_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(stream_ptr, stream_len) }
    };
    if session.verify_final_stream(slice) { 1 } else { 0 }
}

/// Begin incremental §13 ⑧⑨ verification for spill-backed recovery.
///
/// # Safety
/// `handle` must be null or a live receiver created by
/// [`airferry_receiver_create`], externally serialized against other calls.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_final_verify_begin(
    handle: *mut ReceiverSession,
) -> i32 {
    if handle.is_null() {
        return 0;
    }
    let session = unsafe { &mut *handle };
    if session.final_verify_begin() { 1 } else { 0 }
}

/// Feed the next contiguous canonical-stream block to the incremental gate.
///
/// # Safety
/// `handle` must be null or a live receiver created by
/// [`airferry_receiver_create`], externally serialized against other calls.
/// `stream_ptr` must be null or valid for reads of `stream_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_final_verify_feed(
    handle: *mut ReceiverSession,
    stream_ptr: *const u8,
    stream_len: usize,
) -> i32 {
    if handle.is_null() || (stream_ptr.is_null() && stream_len != 0) {
        return 0;
    }
    let session = unsafe { &mut *handle };
    let slice = if stream_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(stream_ptr, stream_len) }
    };
    if session.final_verify_feed(slice) { 1 } else { 0 }
}

/// Finish incremental §13 ⑧⑨ verification.
///
/// # Safety
/// `handle` must be null or a live receiver created by
/// [`airferry_receiver_create`], externally serialized against other calls.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_final_verify_finish(
    handle: *mut ReceiverSession,
) -> i32 {
    if handle.is_null() {
        return 0;
    }
    let session = unsafe { &mut *handle };
    if session.final_verify_finish() { 1 } else { 0 }
}

/// Restore receiver from stored ROOT frame bytes + completed chunk indices (§12 resume).
/// Returns 1 on success, 0 on error.
///
/// # Safety
/// `handle` must be null or a live receiver created by
/// [`airferry_receiver_create`], externally serialized against other calls.
/// `root_ptr` must be null or valid for reads of `root_len` bytes;
/// `completed_ptr` must be null or valid for reads of `completed_len` u32s.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_resume(
    handle: *mut ReceiverSession,
    root_ptr: *const u8,
    root_len: usize,
    completed_ptr: *const u32,
    completed_len: usize,
) -> i32 {
    if handle.is_null() || root_ptr.is_null() || (completed_ptr.is_null() && completed_len != 0) {
        return 0;
    }
    let session = unsafe { &mut *handle };
    let root_bytes = unsafe { std::slice::from_raw_parts(root_ptr, root_len) };
    let completed = if completed_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(completed_ptr, completed_len) }
    };
    if session.resume(root_bytes, completed) { 1 } else { 0 }
}

/// Evict one chunk from both ledgers after a host-side spill re-verification
/// failure (§11/§12): the sender's next epoch re-supplies it. Returns 1 when
/// the index was resident in either ledger.
///
/// # Safety
/// `handle` must be null or a live receiver created by
/// [`airferry_receiver_create`], externally serialized against other calls.
#[no_mangle]
pub unsafe extern "C" fn airferry_receiver_invalidate_chunk(
    handle: *mut ReceiverSession,
    index: u32,
) -> i32 {
    if handle.is_null() {
        return 0;
    }
    let session = unsafe { &mut *handle };
    if session.invalidate_chunk(index) { 1 } else { 0 }
}

/// Free a string returned by [`airferry_receiver_snapshot_json`].
/// Passing null is a no-op.
///
/// # Safety
/// `ptr` must be null or a pointer previously returned by
/// [`airferry_receiver_snapshot_json`] that has not been freed yet.
#[no_mangle]
pub unsafe extern "C" fn airferry_free_string(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: caller guarantees the provenance of `ptr`.
    unsafe { drop(std::ffi::CString::from_raw(ptr)) };
}

// ─── helpers ──────────────────────────────────────────────────────────────

/// Write `s` as a NUL-terminated byte sequence into `out[..cap]`. If `out` is
/// null or too small, just return the required length (bytes + NUL). Otherwise
/// copy the bytes, append `\0`, and return bytes written (incl. NUL).
fn write_cstr(s: &str, out: *mut u8, cap: usize) -> usize {
    let needed = s.len() + 1; // bytes + NUL
    if out.is_null() || cap < needed {
        return needed;
    }
    // SAFETY: caller guarantees `out[..cap]` is writable for this call and
    // `cap >= needed`, so `out[..needed]` is in bounds.
    unsafe {
        std::ptr::copy_nonoverlapping(s.as_ptr(), out, s.len());
        *out.add(s.len()) = 0;
    }
    needed
}

fn progress_json(p: &Progress) -> String {
    format!(
        r#"{{"decoded_symbols":{},"total_symbols":{},"symbol_size":{},"received_symbols":{},"frames_seen":{},"frames_duplicate":{},"frames_corrupt":{},"decoded_blocks":{},"total_blocks":{},"decoded_fraction":{:.4},"loss_ratio":{:.4},"complete":{},"meta_confirmed":{},"session_mismatch_streak":{}}}"#,
        p.decoded_symbols,
        p.total_symbols,
        p.symbol_size,
        p.received_symbols,
        p.frames_seen,
        p.frames_duplicate,
        p.frames_corrupt,
        p.decoded_blocks,
        p.total_blocks,
        p.decoded_fraction(),
        p.loss_ratio(),
        p.is_complete(),
        p.meta_confirmed,
        p.session_mismatch_streak
    )
}

/// Logging sink. Native (non-Android) builds go to stderr; on Android the JNI
/// layer routes through `__android_log_write`. (This module never builds on
/// Android — the `cffi` feature is host-controlled — but keep the signature so
/// a future cross-target build can't silently drop logs.)
fn cffi_log(msg: &str) {
    eprintln!("[airferry] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_status_shared_contract_unchanged() {
        // The bit layout + sentinel now live in `ingest_status`; this binding
        // must still honor that contract. The dedicated layout/clamp/sentinel
        // assertions live in `ingest_status::tests` — here we just guard that
        // the C ABI still references the same shared symbol (no local copy
        // silently drifted back in).
        assert_eq!(ingest_status::INGEST_ERROR, 0xFFFF_FFFFu64 << 32);
        assert_eq!(
            ingest_status::pack(true, true, false, false, 0x1234, 0x5678),
            0b11 | (0x1234u64 << 8) | (0x5678u64 << 32)
        );
    }

    #[test]
    fn write_cstr_returns_required_when_null_or_small() {
        let s = "hello";
        let needed = 6; // 5 bytes + NUL
        assert_eq!(write_cstr(s, std::ptr::null_mut(), 0), needed);
        let mut buf = [0u8; 5];
        assert_eq!(write_cstr(s, buf.as_mut_ptr(), buf.len()), needed);
    }

    #[test]
    fn write_cstr_writes_bytes_and_nul_when_large_enough() {
        let s = "hello";
        let mut buf = [0u8; 16];
        let written = write_cstr(s, buf.as_mut_ptr(), buf.len());
        assert_eq!(written, 6);
        assert_eq!(&buf[..5], b"hello");
        assert_eq!(buf[5], 0);
    }

    #[test]
    fn create_destroy_roundtrip_does_not_leak() {
        let h = airferry_receiver_create(42, 0);
        assert!(!h.is_null());
        // SAFETY: this test owns `h` exclusively and all temporary buffers live
        // across each call.
        unsafe {
            // Null frame pointer → INGEST_ERROR, no crash.
            assert_eq!(
                airferry_receiver_ingest(h, std::ptr::null(), 0),
                ingest_status::INGEST_ERROR
            );
            // A fresh (no-descriptor) session reports empty/zero snapshot
            // fields; the JSON is complete and parseable.
            assert_eq!(airferry_receiver_is_complete(h), 0);
            let snap = airferry_receiver_snapshot_json(h);
            let snap_str = std::ffi::CStr::from_ptr(snap);
            let json = snap_str.to_str().unwrap();
            assert!(json.starts_with('{') && json.ends_with('}'));
            assert!(json.contains("\"schema_version\":2"));
            assert!(json.contains("\"meta_confirmed\":false"));
            assert!(json.contains("\"transfer_id_hex\":\"\""));
            airferry_free_string(snap);
            // progress_json first returns the required length when the buffer is
            // too small, then writes a `{`-prefixed JSON + NUL when it fits.
            let mut tiny = [0u8; 8];
            let needed = airferry_receiver_progress_json(h, tiny.as_mut_ptr(), tiny.len());
            assert!(
                needed > tiny.len(),
                "JSON must be longer than the tiny buffer"
            );
            let mut buf = vec![0u8; needed];
            let written = airferry_receiver_progress_json(h, buf.as_mut_ptr(), buf.len());
            assert_eq!(written, needed);
            assert_eq!(buf[0], b'{');
            assert_eq!(buf[written - 1], 0); // NUL terminator
            airferry_receiver_destroy(h);
        }
    }

    #[test]
    fn null_handle_is_safe_everywhere() {
        // SAFETY: the C contract explicitly permits null handles/pointers in
        // these no-op/error paths.
        unsafe {
            assert_eq!(
                airferry_receiver_ingest(std::ptr::null_mut(), std::ptr::null(), 0),
                ingest_status::INGEST_ERROR
            );
            assert_eq!(airferry_receiver_is_complete(std::ptr::null()), 0);
            let mut out_buf: *mut u8 = std::ptr::null_mut();
            let mut out_len: usize = 0;
            assert_eq!(
                airferry_receiver_assemble(std::ptr::null_mut(), &mut out_buf, &mut out_len),
                0
            );
            assert_eq!(
                airferry_receiver_progress_json(std::ptr::null(), std::ptr::null_mut(), 0),
                0
            );
            assert!(airferry_receiver_snapshot_json(std::ptr::null()).is_null());
            // destroy/free are no-ops on null.
            airferry_receiver_destroy(std::ptr::null_mut());
            airferry_buffer_free(std::ptr::null_mut(), 0);
            airferry_free_string(std::ptr::null_mut());
        }
    }

    #[test]
    fn abi_version_is_reported() {
        assert_eq!(airferry_native_abi_version(), AIRFERRY_NATIVE_ABI_VERSION);
        assert_eq!(AIRFERRY_NATIVE_ABI_VERSION, 3);
    }

    #[test]
    fn assemble_requires_both_output_parameters() {
        let handle = airferry_receiver_create(7, 0);
        assert!(!handle.is_null());
        let mut out_buf = 1usize as *mut u8;
        let mut out_len = usize::MAX;
        // SAFETY: this test owns the live handle. Null output pointers are
        // explicitly rejected without allocating or touching the session.
        unsafe {
            assert_eq!(
                airferry_receiver_assemble(handle, std::ptr::null_mut(), &mut out_len),
                0
            );
            assert_eq!(out_len, usize::MAX);
            assert_eq!(
                airferry_receiver_assemble(handle, &mut out_buf, std::ptr::null_mut()),
                0
            );
            assert_eq!(out_buf, 1usize as *mut u8);
            airferry_receiver_destroy(handle);
        }
    }
}
