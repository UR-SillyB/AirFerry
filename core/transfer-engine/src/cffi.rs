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
//!   status word, [`airferry_receiver_file_size`]) are copied and need no
//!   cleanup.
//! - [`airferry_receiver_assemble`] returns a Rust-allocated buffer + length;
//!   the caller must copy the bytes out and then call [`airferry_buffer_free`]
//!   on the pointer to release Rust's allocation. Never `free` it from the host.
//! - `*_into_buffer` functions (progress JSON, file name) take a caller-owned
//!   buffer + capacity and return the number of bytes written (or, when the
//!   buffer is null/too small, the required length so the caller can
//!   re-allocate and retry). No Rust-side allocation crosses the boundary.

#![cfg(feature = "cffi")]

use crate::receiver::ReceiverSession;
use crate::Progress;
use qr_protocol::frame::SessionIdRaw;

/// Pack a per-frame status into a 64-bit word (bit layout documented on
/// [`airferry_receiver_ingest`]). Kept byte-for-byte identical to the JNI
/// layer's `pack_ingest_status` so both hosts parse the same wire contract.
const INGEST_ERROR: u64 = 0xFFFF_FFFFu64 << 32;

fn pack_ingest_status(
    complete: bool,
    accepted: bool,
    mismatch_streak: u32,
    received_symbols: u32,
) -> u64 {
    let mut bits: u64 = 0;
    if complete {
        bits |= 1;
    }
    if accepted {
        bits |= 1 << 1;
    }
    let streak16 = (mismatch_streak & 0xFFFF) as u64;
    bits |= streak16 << 8;
    let recv32 = (received_symbols & 0xFFFF_FFFF) as u64;
    bits |= recv32 << 32;
    bits
}

/// Create a "cache-only" receiver. `sid_lo`/`sid_hi` split the 128-bit session
/// id into its low/high 64-bit halves (host order). As on Android, no object
/// metadata is built from the totals yet — data frames are buffered until the
/// first validated descriptor frame supplies the authoritative OTI. Returns a
/// non-null opaque handle on success.
#[no_mangle]
pub extern "C" fn airferry_receiver_create(sid_lo: u64, sid_hi: u64) -> *mut ReceiverSession {
    let sid: SessionIdRaw = ((sid_hi as u128) << 64) | (sid_lo as u128);
    let session = ReceiverSession::new_pending(sid);
    Box::into_raw(Box::new(session))
}

/// Destroy a receiver created by [`airferry_receiver_create`]. Passing null is
/// a no-op. After this returns, the handle is invalid and must not be reused.
#[no_mangle]
pub extern "C" fn airferry_receiver_destroy(handle: *mut ReceiverSession) {
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
/// Returns `INGEST_ERROR` (`received_symbols == u32::MAX`) on a null handle or
/// a frame that fails wire validation (bad magic / CRC / version); the host
/// treats this as "frame rejected, nothing to do".
#[no_mangle]
pub extern "C" fn airferry_receiver_ingest(
    handle: *mut ReceiverSession,
    frame_bytes: *const u8,
    frame_len: usize,
) -> u64 {
    if handle.is_null() {
        return INGEST_ERROR;
    }
    // SAFETY: caller guarantees `frame_bytes[..frame_len]` is a valid borrowed
    // slice for the duration of this call.
    let slice: &[u8] = if frame_bytes.is_null() || frame_len == 0 {
        return INGEST_ERROR;
    } else {
        unsafe { std::slice::from_raw_parts(frame_bytes, frame_len) }
    };
    // SAFETY: caller guarantees `handle` is valid and not concurrently mutated.
    let session = unsafe { &mut *handle };
    let frame = match qr_protocol::Frame::from_bytes(slice) {
        Ok(f) => f,
        Err(e) => {
            cffi_log(&format!("frame rejected (len={}): {:?}", slice.len(), e));
            return INGEST_ERROR;
        }
    };
    let prev_received = session.progress().received_symbols;
    if let Err(e) = session.ingest(frame) {
        cffi_log(&format!("ingest error: {e}"));
    }
    let p = session.progress();
    let complete = session.is_complete();
    let accepted = p.received_symbols > prev_received;
    pack_ingest_status(
        complete,
        accepted,
        p.session_mismatch_streak,
        p.received_symbols,
    )
}

/// Return 1 if the object is fully decoded, 0 otherwise (including a null
/// handle).
#[no_mangle]
pub extern "C" fn airferry_receiver_is_complete(handle: *const ReceiverSession) -> i32 {
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
#[no_mangle]
pub extern "C" fn airferry_receiver_assemble(
    handle: *const ReceiverSession,
    out_buf: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    if handle.is_null() {
        return 0;
    }
    // SAFETY: shared borrow; caller guarantees the handle is valid.
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    let data = match session.assemble_result() {
        Ok(Some(d)) => d,
        Ok(None) => return 0,
        Err(e) => {
            cffi_log(&format!("assemble failed: {e}"));
            return 0;
        }
    };
    let len = data.len();
    let ptr = Box::into_raw(data.into_boxed_slice()) as *mut u8;
    // SAFETY: `out_buf`/`out_len` are caller-provided out-params; writing to
    // them is the documented contract.
    if !out_buf.is_null() {
        unsafe {
            *out_buf = ptr;
        }
    }
    if !out_len.is_null() {
        unsafe {
            *out_len = len;
        }
    }
    1
}

/// Release a buffer returned by [`airferry_receiver_assemble`]. `ptr`/`len`
/// must be exactly the values the assemble call wrote. Passing null/0 is a
/// no-op. Do NOT call this on any pointer the host allocated itself.
#[no_mangle]
pub extern "C" fn airferry_buffer_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
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

/// Write the NUL-terminated progress JSON into the caller-owned `out` buffer.
///
/// - If `out` is null or `cap` is smaller than needed, writes nothing and
///   returns the required length (including the trailing NUL). The host can
///   then allocate that many bytes and call again.
/// - Otherwise writes the JSON + NUL terminator and returns the number of
///   bytes written.
///
/// On a null handle, returns 0 (nothing to write).
#[no_mangle]
pub extern "C" fn airferry_receiver_progress_json(
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

/// Write the recovered file name (UTF-8 + NUL) into the caller buffer using
/// the same length-query protocol as [`airferry_receiver_progress_json`].
/// Empty string when no descriptor has been received yet.
#[no_mangle]
pub extern "C" fn airferry_receiver_file_name(
    handle: *const ReceiverSession,
    out: *mut u8,
    cap: usize,
) -> usize {
    if handle.is_null() {
        return 0;
    }
    let session = unsafe { &*handle };
    let name = session.file_meta().filename.clone();
    write_cstr(&name, out, cap)
}

/// Original file size in bytes (0 if no descriptor received / null handle).
#[no_mangle]
pub extern "C" fn airferry_receiver_file_size(handle: *const ReceiverSession) -> u64 {
    if handle.is_null() {
        return 0;
    }
    let session = unsafe { &*handle };
    session.file_meta().original_size
}

/// CRC32 of the original file (0 if unknown). Returned as `u64` so the full
/// unsigned 32-bit range survives — mirroring the JNI layer's decision to use
/// `jlong` instead of `jint` (CRC32 values like `0xDEADBEEF` would otherwise
/// look negative as a signed 32-bit int).
#[no_mangle]
pub extern "C" fn airferry_receiver_crc32(handle: *const ReceiverSession) -> u64 {
    if handle.is_null() {
        return 0;
    }
    let session = unsafe { &*handle };
    session.file_meta().crc32 as u64
}

/// Return 1 if the descriptor supplied a real CRC32 (so the host should verify
/// it against the recovered bytes), or 0 if the CRC is unknown and must NOT be
/// compared. CRC32 can legitimately be 0, so `crc32() == 0` is not a safe test.
#[no_mangle]
pub extern "C" fn airferry_receiver_crc32_known(handle: *const ReceiverSession) -> i32 {
    if handle.is_null() {
        return 0;
    }
    let session = unsafe { &*handle };
    session.file_meta().crc32_known as i32
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
        r#"{{"decoded_symbols":{},"total_symbols":{},"received_symbols":{},"frames_seen":{},"frames_duplicate":{},"frames_corrupt":{},"decoded_blocks":{},"total_blocks":{},"decoded_fraction":{:.4},"loss_ratio":{:.4},"complete":{},"meta_confirmed":{},"session_mismatch_streak":{}}}"#,
        p.decoded_symbols,
        p.total_symbols,
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
    fn pack_status_bit_layout() {
        // bit 0 = complete, bit 1 = accepted
        assert_eq!(pack_ingest_status(false, false, 0, 0), 0);
        assert_eq!(pack_ingest_status(true, false, 0, 0), 1);
        assert_eq!(pack_ingest_status(false, true, 0, 0), 1 << 1);
        assert_eq!(pack_ingest_status(true, true, 0, 0), 0b11);
        // bits 8..23 = streak
        assert_eq!(pack_ingest_status(false, false, 1, 0), 1 << 8);
        assert_eq!(pack_ingest_status(false, false, 0xFFFF, 0), 0xFFFF << 8);
        // streak is clamped to 16 bits
        assert_eq!(pack_ingest_status(false, false, 0x1FFFF, 0), 0xFFFF << 8);
        // bits 32..63 = received_symbols
        assert_eq!(pack_ingest_status(false, false, 0, 1), 1u64 << 32);
        assert_eq!(
            pack_ingest_status(true, true, 0x1234, 0x5678),
            0b11 | (0x1234u64 << 8) | (0x5678u64 << 32)
        );
    }

    #[test]
    fn ingest_error_sentinel_matches_jni() {
        // Must be bit-for-bit identical to jni.rs::INGEST_ERROR so the host
        // unpack code can treat both bindings the same way.
        assert_eq!(INGEST_ERROR, 0xFFFF_FFFFu64 << 32);
        assert_eq!(((INGEST_ERROR >> 32) & 0xFFFF_FFFF), 0xFFFF_FFFF);
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
        // Null frame pointer → INGEST_ERROR, no crash.
        assert_eq!(airferry_receiver_ingest(h, std::ptr::null(), 0), INGEST_ERROR);
        // Accessors on a fresh (no-descriptor) session report empty/zero.
        assert_eq!(airferry_receiver_is_complete(h), 0);
        assert_eq!(airferry_receiver_file_size(h), 0);
        assert_eq!(airferry_receiver_crc32(h), 0);
        assert_eq!(airferry_receiver_crc32_known(h), 0);
        // progress_json first returns the required length when the buffer is
        // too small, then writes a `{`-prefixed JSON + NUL when it fits.
        let mut tiny = [0u8; 8];
        let needed = airferry_receiver_progress_json(h, tiny.as_mut_ptr(), tiny.len());
        assert!(needed > tiny.len(), "JSON must be longer than the tiny buffer");
        let mut buf = vec![0u8; needed];
        let written = airferry_receiver_progress_json(h, buf.as_mut_ptr(), buf.len());
        assert_eq!(written, needed);
        assert_eq!(buf[0], b'{');
        assert_eq!(buf[written - 1], 0); // NUL terminator
        airferry_receiver_destroy(h);
    }

    #[test]
    fn null_handle_is_safe_everywhere() {
        assert_eq!(airferry_receiver_ingest(std::ptr::null_mut(), std::ptr::null(), 0), INGEST_ERROR);
        assert_eq!(airferry_receiver_is_complete(std::ptr::null()), 0);
        let mut out_buf: *mut u8 = std::ptr::null_mut();
        let mut out_len: usize = 0;
        assert_eq!(airferry_receiver_assemble(std::ptr::null(), &mut out_buf, &mut out_len), 0);
        assert_eq!(airferry_receiver_progress_json(std::ptr::null(), std::ptr::null_mut(), 0), 0);
        assert_eq!(airferry_receiver_file_name(std::ptr::null(), std::ptr::null_mut(), 0), 0);
        assert_eq!(airferry_receiver_file_size(std::ptr::null()), 0);
        assert_eq!(airferry_receiver_crc32(std::ptr::null()), 0);
        assert_eq!(airferry_receiver_crc32_known(std::ptr::null()), 0);
        // destroy/free are no-ops on null.
        airferry_receiver_destroy(std::ptr::null_mut());
        airferry_buffer_free(std::ptr::null_mut(), 0);
    }
}
