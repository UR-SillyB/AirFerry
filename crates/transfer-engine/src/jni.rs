//! Android JNI bindings for the receiver side.
//!
//! Uses the official `jni` crate (correct JNIEnv ABI across all Android
//! versions / vendors / ART implementations) with `extern "system"` — the
//! correct calling convention for JNI native methods on 64-bit Android.

#![cfg(feature = "jni")]

use crate::receiver::ReceiverSession;
use crate::Progress;
use jni::objects::{JByteArray, JClass};
use jni::sys::{jint, jlong, jsize};
use jni::JNIEnv;
use qr_protocol::frame::SessionIdRaw;

#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverCreate(
    _env: JNIEnv,
    _class: JClass,
    session_id_lo: jlong,
    session_id_hi: jlong,
    _total_blocks: jint,
    _total_symbols: jint,
    _symbol_size: jint,
) -> jlong {
    let sid: SessionIdRaw =
        ((session_id_hi as u64 as u128) << 64) | (session_id_lo as u64 as u128);
    // Cache-only bootstrap: do NOT build a decoder from these caller-supplied
    // totals (a guessed early layout, and `derive_meta_from_totals`'s OTI build
    // can itself assert on large values). Data frames are buffered until the
    // first *validated* descriptor frame supplies the authoritative, sanity-
    // checked OTI (see ReceiverSession::ingest), which builds the real decoder.
    let session = ReceiverSession::new_pending(sid);
    Box::into_raw(Box::new(session)) as jlong
}

#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverDestroy(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if handle != 0 {
        unsafe { drop(Box::from_raw(handle as *mut ReceiverSession)) };
    }
}

/// Ingest a frame. Returns a freshly-allocated `byte[]` containing the
/// NUL-terminated progress JSON (or an empty array on error). Returning a new
/// array instead of writing into a caller-supplied buffer removes the fixed
/// 1024-byte cap that previously truncated JSON (and threw
/// `ArrayIndexOutOfBoundsException` on long transfers), silently stalling the
/// receiver's progress updates.
#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverIngest(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    frame_bytes: JByteArray,
) -> jni::sys::jbyteArray {
    // Helper: allocate a fresh byte[] of `len` bytes and fill it from `buf`.
    // Returns null on allocation failure. Inlined (not a closure) so it does
    // not capture a borrow of `env` and conflict with later uses of `env`.
    fn fill_array(
        env: &mut JNIEnv,
        buf: &[u8],
    ) -> jni::sys::jbyteArray {
        let len = buf.len() as jsize;
        let arr = match env.new_byte_array(len) {
            Ok(a) => a,
            Err(_) => return std::ptr::null_mut(),
        };
        // SAFETY: u8 and i8 have the same layout; the slice is a valid
        // reinterpretation for the JNI SetByteArrayRegion call.
        let i8_buf: &[i8] =
            unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const i8, buf.len()) };
        if env.set_byte_array_region(&arr, 0, i8_buf).is_ok() {
            arr.into_raw()
        } else {
            std::ptr::null_mut()
        }
    }

    if handle == 0 {
        return fill_array(&mut env, &[]);
    }
    let frame_vec: Vec<u8> = match env.convert_byte_array(&frame_bytes) {
        Ok(v) => v,
        Err(_) => return fill_array(&mut env, &[]),
    };
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    match qr_protocol::Frame::from_bytes(&frame_vec) {
        Ok(frame) => {
            let is_descriptor = frame.header.flags & qr_protocol::frame::FLAG_DESCRIPTOR != 0;
            match session.ingest(frame) {
                Ok(_) => {}
                Err(e) => {
                    // A SessionMismatch on a data frame would silently drop
                    // every symbol — surface it so the cause is visible.
                    android_log(&format!("ingest error: {e}"));
                }
            }
            let p = session.progress();
            // Log the first few frames + any descriptor + when received is
            // suspiciously stuck at 0 while frames are flowing. Throttled by
            // frame_index to avoid flooding logcat.
            if p.frames_seen <= 3 || is_descriptor || (p.frames_seen % 50 == 0 && !session.is_complete()) {
                android_log(&format!(
                    "f={} desc={} meta={} recv={} dec={} {}/{} mismatch={}",
                    p.frames_seen, is_descriptor, p.meta_confirmed,
                    p.received_symbols, p.decoded_blocks, p.decoded_symbols, p.total_symbols,
                    p.session_mismatch_streak
                ));
            }
            let json = progress_json(&session.progress());
            let mut buf = json.into_bytes();
            buf.push(0); // NUL terminator for C-string reads on the Kotlin side.
            fill_array(&mut env, &buf)
        }
        Err(e) => {
            android_log(&format!("frame rejected (len={}): {:?}", frame_vec.len(), e));
            fill_array(&mut env, &[])
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverIsComplete(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jint {
    if handle == 0 {
        return 0;
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    session.is_complete() as jint
}

/// Recover the assembled file as a freshly-allocated `byte[]`.
///
/// Returns the bytes directly (null if not complete / on error), instead of the
/// old two-call `receiverAssembledLength` (jint) + `receiverAssemble(into buf)`
/// pattern. That pattern had two problems this fixes:
///  1. `receiverAssembledLength` returned `jint`, so files > 2 GB truncated the
///     length and `ByteArray(len)` then threw on a negative size.
///  2. The length and the fill were two separate JNI calls with no locking, so a
///     concurrent mutation could make the second call's length differ from the
///     first's. Returning a new array is a single atomic call.
#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverAssembleBytes(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jni::sys::jbyteArray {
    if handle == 0 {
        return null_byte_array(&mut env);
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    let data = match session.assemble_result() {
        Ok(Some(d)) => d,
        Ok(None) => return null_byte_array(&mut env),
        Err(e) => {
            android_log(&format!("assemble failed: {e}"));
            return null_byte_array(&mut env);
        }
    };
    // Allocate a fresh byte[] of exactly data.len() and copy. jsize is i32, so a
    // Vec longer than i32::MAX (2 GiB) cannot be represented as a Java array in
    // one piece anyway — log and return null rather than truncating silently.
    let len = match jsize::try_from(data.len()) {
        Ok(n) => n,
        Err(_) => {
            android_log(&format!(
                "assemble result {} bytes exceeds Java array max (2 GiB)",
                data.len()
            ));
            return null_byte_array(&mut env);
        }
    };
    let arr = match env.new_byte_array(len) {
        Ok(a) => a,
        Err(_) => return null_byte_array(&mut env),
    };
    // SAFETY: u8 and i8 have the same layout; the slice is a valid
    // reinterpretation for SetByteArrayRegion.
    let i8_buf: &[i8] =
        unsafe { std::slice::from_raw_parts(data.as_ptr() as *const i8, data.len()) };
    if env.set_byte_array_region(&arr, 0, i8_buf).is_ok() {
        arr.into_raw()
    } else {
        null_byte_array(&mut env)
    }
}

/// Allocate an empty (0-length) byte[] — the "nothing to return" sentinel.
fn null_byte_array(env: &mut JNIEnv) -> jni::sys::jbyteArray {
    match env.new_byte_array(0) {
        Ok(a) => a.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

// ===== File metadata accessors =====
// Kotlin reads these after a descriptor frame arrives to display the filename,
// original size, and verify CRC32.

/// Returns the original filename as a Java String (or empty if unknown).
#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverFileName(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jni::sys::jstring {
    if handle == 0 {
        return std::ptr::null_mut();
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    let name = session.file_meta().filename.clone();
    match env.new_string(&name) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Returns the original file size (0 if unknown).
#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverFileSize(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jlong {
    if handle == 0 {
        return 0;
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    session.file_meta().original_size as jlong
}

/// Returns the CRC32 of the original file (0 if unknown).
///
/// Returned as `jlong` (not `jint`) so the full unsigned 32-bit range
/// (0..=0xFFFF_FFFF) survives intact — Kotlin's `Int` is signed, so a value
/// like `0xDEADBEEF` would otherwise arrive as a negative number and break
/// equality comparisons with a receiver-computed CRC.
#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverCrc32(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jlong {
    if handle == 0 {
        return 0;
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    session.file_meta().crc32 as u64 as jlong
}

/// Returns 1 if the descriptor supplied a real CRC32 (so the receiver should
/// verify it), or 0 if the CRC is unknown (v1 descriptor / not yet received)
/// and must NOT be compared against the recovered bytes.
///
/// This exists because CRC32 can legitimately be 0 (~1 in 2^32 files): the old
/// `expectedCrc == 0L` sentinel on the Kotlin side mislabelled such files as
/// "unverified". `crc32_known` is the authoritative "is there a value" flag.
#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverCrc32Known(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jint {
    if handle == 0 {
        return 0;
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    session.file_meta().crc32_known as jint
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

#[cfg(target_os = "android")]
fn android_log(msg: &str) {
    extern "C" {
        fn __android_log_write(prio: i32, tag: *const u8, text: *const u8) -> i32;
    }
    const ANDROID_LOG_ERROR: i32 = 6;
    static TAG: &[u8] = b"easytransfer\0";
    let mut buf: Vec<u8> = Vec::with_capacity(msg.len() + 1);
    buf.extend_from_slice(msg.as_bytes());
    buf.push(0);
    unsafe {
        __android_log_write(ANDROID_LOG_ERROR, TAG.as_ptr(), buf.as_ptr());
    }
}

#[cfg(not(target_os = "android"))]
fn android_log(msg: &str) {
    eprintln!("[easytransfer] {msg}");
}
