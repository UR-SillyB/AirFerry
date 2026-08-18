//! Android JNI bindings for the receiver side.
//!
//! Uses the official `jni` crate (correct JNIEnv ABI across all Android
//! versions / vendors / ART implementations) with `extern "system"` — the
//! correct calling convention for JNI native methods on 64-bit Android.
//!
//! ## Handle model
//! A receiver session is heap-allocated (`Box<ReceiverSession>`), and its raw
//! pointer is returned to Kotlin as an opaque `jlong` handle. Every function
//! takes that handle back as an argument; pass it to
//! [`Java_com_airferry_app_nativelib_NativeBridge_receiverDestroy`] to release
//! the session. The handle is *not* thread-safe — the host must serialize all
//! calls that touch the same handle (the Android client does this with
//! `QrDecodePool`'s `ingestLock`, exactly like the Windows client's single
//! ingest lock around the C ABI; see [`crate::cffi`] for the mirrored
//! contract).

#![cfg(feature = "jni")]

use crate::ingest_status;
use crate::receiver::ReceiverSession;
use crate::Progress;
use jni::objects::{JByteArray, JClass};
use jni::sys::{jint, jlong, jsize};
use jni::JNIEnv;

/// ABI / protocol capability version of this JNI library.
///
/// The wire protocol is AF2 (magic `AF`, wire_version 2, see `docs/SPEC.md`);
/// this counter is a *separate* Android-side capability marker that advances
/// whenever the native library gains behaviour the Kotlin host depends on.
///
/// - 1: legacy v1 (pre-AF2) segmented receive path.
/// - 2: the 16 per-field receiver getters were replaced by the single
///      `receiverSnapshotJson` (`ReceiverSnapshotV2`); old hosts calling the
///      removed symbols get an `UnsatisfiedLinkError` instead of silent zeros.
/// - 3: bounded-memory incremental §13 final verification was added.
///
/// The host (`NativeBridge.nativeAbiVersion`) handshakes on startup: if the
/// loaded `.so` predates this symbol (`UnsatisfiedLinkError`) or reports a
/// lower version, the app refuses to run as a receiver instead of silently
/// "staying synchronising" on >32 MiB transfers with a stale library.
pub const AIRFERRY_NATIVE_ABI_VERSION: jint = 3;

/// Report the native ABI / protocol capability version. Returns
/// [`AIRFERRY_NATIVE_ABI_VERSION`].
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_nativeAbiVersion(
    _env: JNIEnv,
    _class: JClass,
) -> jint {
    AIRFERRY_NATIVE_ABI_VERSION
}

#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverCreate(
    _env: JNIEnv,
    _class: JClass,
    session_id_lo: jlong,
    session_id_hi: jlong,
) -> jlong {
    let sid: u128 = ((session_id_hi as u64 as u128) << 64) | (session_id_lo as u64 as u128);
    // Cache-only bootstrap: do NOT build a decoder from guessed caller totals.
    // Data frames are buffered until the first *validated* descriptor frame
    // supplies the authoritative, sanity-checked OTI (see ReceiverSession::ingest),
    // which builds the real decoder.
    let session = ReceiverSession::new_pending(sid);
    Box::into_raw(Box::new(session)) as jlong
}

#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverDestroy(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if handle != 0 {
        unsafe { drop(Box::from_raw(handle as *mut ReceiverSession)) };
    }
}

/// Ingest a frame.
///
/// Returns a packed `jlong` status word instead of a per-frame JSON byte[].
/// Building + crossing the JNI boundary with a JSON string on *every* decoded
/// frame (the UI only refreshes ~7 Hz) is pure waste: it allocates a Rust
/// `String`, a Java `byte[]`, a Kotlin `String`, and a `JSONObject` parse per
/// frame at 60 fps. The packed word carries just what the ingest path needs to
/// decide completion + re-init, and the full progress is fetched on demand via
/// [`receiverProgressJson`] at the UI's throttle cadence.
///
/// Bit layout of the returned `jlong` (all fields unsigned):
///   - bit  0      : `complete` (1 once the object is fully decoded)
///   - bit  1      : `accepted` (1 if this frame contributed a new symbol)
///   - bits 8..23  : `session_mismatch_streak` (0..=0xFFFF)
///   - bits 32..63 : `received_symbols` (low 32 bits; capped well below 2^32)
///
/// Returns 0 only on a null handle. A byte-array conversion failure or a
/// frame that fails wire validation (bad magic / CRC / version) returns the
/// [`ingest_status::INGEST_ERROR`] sentinel (`received_symbols == u32::MAX`,
/// all flags clear) — the host treats it as "frame rejected, nothing to do".
/// A session-level `ingest` error (e.g. `SessionMismatch`) is logged but the
/// function still returns the *current* packed status word, since the session
/// stays alive and its progress remains readable.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverIngest(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
    frame_bytes: JByteArray,
) -> jlong {
    if handle == 0 {
        return 0;
    }
    let frame_vec: Vec<u8> = match env.convert_byte_array(&frame_bytes) {
        Ok(v) => v,
        Err(_) => return ingest_status::INGEST_ERROR as jlong,
    };
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    session.ingest(&frame_vec) as jlong
}

/// On-demand progress query (JSON). The UI calls this on its ~7 Hz refresh
/// cadence instead of parsing a JSON on every ingested frame. Returns a freshly
/// allocated `byte[]` of the NUL-terminated JSON, or an empty array on error.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverProgressJson(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jni::sys::jbyteArray {
    if handle == 0 {
        return null_byte_array(&mut env);
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    let json = progress_json(&session.progress());
    let mut buf = json.into_bytes();
    buf.push(0); // NUL terminator for C-string reads on the Kotlin side.
    fill_array(&mut env, &buf)
}

/// Allocate a fresh byte[] of `len` bytes and fill it from `buf`. Returns null
/// on allocation failure. Inlined (not a closure) so it does not capture a
/// borrow of `env` and conflict with later uses of `env`.
fn fill_array(env: &mut JNIEnv, buf: &[u8]) -> jni::sys::jbyteArray {
    let len = buf.len() as jsize;
    let arr = match env.new_byte_array(len) {
        Ok(a) => a,
        Err(_) => return std::ptr::null_mut(),
    };
    // SAFETY: u8 and i8 have the same layout; the slice is a valid
    // reinterpretation for the JNI SetByteArrayRegion call.
    let i8_buf: &[i8] = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const i8, buf.len()) };
    if env.set_byte_array_region(&arr, 0, i8_buf).is_ok() {
        arr.into_raw()
    } else {
        std::ptr::null_mut()
    }
}

#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverIsComplete(
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
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverAssembleBytes(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jni::sys::jbyteArray {
    if handle == 0 {
        return null_byte_array(&mut env);
    }
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    let data = match session.assemble_all() {
        Some(d) => d,
        None => return null_byte_array(&mut env),
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

/// Reassemble chunk `index` bytes. Returns empty byte[] if not ready / on error.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverAssembleChunk(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    index: jint,
) -> jni::sys::jbyteArray {
    if handle == 0 {
        return null_byte_array(&mut env);
    }
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    let Some(raw) = session.assemble_chunk(index as u32) else {
        return null_byte_array(&mut env);
    };
    let len = match jsize::try_from(raw.len()) {
        Ok(n) => n,
        Err(_) => return null_byte_array(&mut env),
    };
    let arr = match env.new_byte_array(len) {
        Ok(a) => a,
        Err(_) => return null_byte_array(&mut env),
    };
    let i8_buf: &[i8] = unsafe { std::slice::from_raw_parts(raw.as_ptr() as *const i8, raw.len()) };
    if env.set_byte_array_region(&arr, 0, i8_buf).is_ok() {
        arr.into_raw()
    } else {
        null_byte_array(&mut env)
    }
}

/// Index of the chunk completed by the most recent ChunkReady frame, or -1.
/// The host persists that chunk via `receiverAssembleChunk` + forgets it with
/// `receiverForgetChunk` to keep native memory bounded by one chunk.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverLastChunkIndex(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jint {
    if handle == 0 {
        return -1;
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    session.last_completed_chunk_index().map(|i| i as jint).unwrap_or(-1)
}

/// Release a persisted chunk from native memory (eviction). Returns true when
/// the chunk was resident. Completion tracking is unaffected.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverForgetChunk(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    index: jint,
) -> jni::sys::jboolean {
    if handle == 0 || index < 0 {
        return 0;
    }
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    session.forget_chunk(index as u32) as jni::sys::jboolean
}

/// Verify a staged raw chunk against the ROOT-bound Manifest chunk table (§11).
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverVerifyChunk(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    index: jint,
    raw_bytes: jni::sys::jbyteArray,
) -> jni::sys::jboolean {
    if handle == 0 || raw_bytes.is_null() {
        return false as jni::sys::jboolean;
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    // Bind the JNI array wrapper to a named local: `get_array_elements`
    // borrows it, and a temporary (`&JByteArray::from_raw(...)`) would be
    // dropped while the returned element view is still in use (E0716).
    let arr = unsafe { jni::objects::JByteArray::from_raw(raw_bytes) };
    let bytes = match unsafe { env.get_array_elements(&arr, jni::objects::ReleaseMode::NoCopyBack) } {
        Ok(elems) => elems,
        Err(_) => return false as jni::sys::jboolean,
    };
    let slice = unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const u8, bytes.len()) };
    session.verify_chunk(index as u32, slice) as jni::sys::jboolean
}

/// Run §13 ⑧⑨ integrity chain over the reassembled canonical stream.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverVerifyFinalStream(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    stream_bytes: jni::sys::jbyteArray,
) -> jni::sys::jboolean {
    if handle == 0 || stream_bytes.is_null() {
        return false as jni::sys::jboolean;
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    let arr = unsafe { jni::objects::JByteArray::from_raw(stream_bytes) };
    let bytes = match unsafe { env.get_array_elements(&arr, jni::objects::ReleaseMode::NoCopyBack) } {
        Ok(elems) => elems,
        Err(_) => return false as jni::sys::jboolean,
    };
    let slice = unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const u8, bytes.len()) };
    session.verify_final_stream(slice) as jni::sys::jboolean
}

/// Begin bounded-memory §13 ⑧⑨ verification.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverFinalVerifyBegin(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jni::sys::jboolean {
    if handle == 0 {
        return false as jni::sys::jboolean;
    }
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    session.final_verify_begin() as jni::sys::jboolean
}

/// Feed the next contiguous canonical-stream block to the incremental gate.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverFinalVerifyFeed(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    stream_bytes: jni::sys::jbyteArray,
) -> jni::sys::jboolean {
    if handle == 0 || stream_bytes.is_null() {
        return false as jni::sys::jboolean;
    }
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    let arr = unsafe { jni::objects::JByteArray::from_raw(stream_bytes) };
    let bytes = match unsafe { env.get_array_elements(&arr, jni::objects::ReleaseMode::NoCopyBack) } {
        Ok(elems) => elems,
        Err(_) => return false as jni::sys::jboolean,
    };
    let slice = unsafe { std::slice::from_raw_parts(bytes.as_ptr() as *const u8, bytes.len()) };
    session.final_verify_feed(slice) as jni::sys::jboolean
}

/// Finish bounded-memory §13 ⑧⑨ verification.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverFinalVerifyFinish(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jni::sys::jboolean {
    if handle == 0 {
        return false as jni::sys::jboolean;
    }
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    session.final_verify_finish() as jni::sys::jboolean
}

/// Restore receiver from stored ROOT frame bytes + completed chunk indices (§12 resume).
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverResume(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    root_frame_bytes: jni::sys::jbyteArray,
    completed_indices: jni::sys::jintArray,
) -> jni::sys::jboolean {
    if handle == 0 || root_frame_bytes.is_null() || completed_indices.is_null() {
        return false as jni::sys::jboolean;
    }
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    let root_arr = unsafe { jni::objects::JByteArray::from_raw(root_frame_bytes) };
    let r_bytes = match unsafe { env.get_array_elements(&root_arr, jni::objects::ReleaseMode::NoCopyBack) } {
        Ok(elems) => elems,
        Err(_) => return false as jni::sys::jboolean,
    };
    let r_slice = unsafe { std::slice::from_raw_parts(r_bytes.as_ptr() as *const u8, r_bytes.len()) };
    let idx_arr = unsafe { jni::objects::JIntArray::from_raw(completed_indices) };
    let c_elems = match unsafe { env.get_array_elements(&idx_arr, jni::objects::ReleaseMode::NoCopyBack) } {
        Ok(elems) => elems,
        Err(_) => return false as jni::sys::jboolean,
    };
    let completed_u32: Vec<u32> = unsafe {
        std::slice::from_raw_parts(c_elems.as_ptr(), c_elems.len())
            .iter()
            .map(|&x| x as u32)
            .collect()
    };
    session.resume(r_slice, &completed_u32) as jni::sys::jboolean
}

/// Evict one chunk from both ledgers after a host-side spill re-verification
/// failure (§11/§12): the sender's next epoch re-supplies it. Mirrors
/// [`ReceiverSession::invalidate_chunk`].
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverInvalidateChunk(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    index: jint,
) -> jni::sys::jboolean {
    if handle == 0 || index < 0 {
        return false as jni::sys::jboolean;
    }
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    session.invalidate_chunk(index as u32) as jni::sys::jboolean
}

/// Single-JSON receiver snapshot (`ReceiverSnapshotV2`, see
/// [`ReceiverSession::snapshot_json`]).
///
/// Replaces the former 16 per-field getters (compression / compressed_size /
/// original_size / file_name / file_size / crc32 / crc32_known / is_segmented
/// / segment_index / segment_count / root_original_size / original_offset /
/// root_session_id_lo/hi / raw_sha256 / root_sha256). One call returns every
/// AF2 snapshot field atomically — no torn reads across getters — and
/// the Kotlin side parses it with `JSONObject`. Returns null on a null handle
/// or string-conversion failure.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_receiverSnapshotJson(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jni::sys::jstring {
    if handle == 0 {
        return std::ptr::null_mut();
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    let json = session.snapshot_json();
    match env.new_string(&json) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Allocate an empty (0-length) byte[] — the "nothing to return" sentinel.
fn null_byte_array(env: &mut JNIEnv) -> jni::sys::jbyteArray {
    match env.new_byte_array(0) {
        Ok(a) => a.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

// ===== Recovered-file / manifest snapshot + progress JSON =====
// All consumed through the single `receiverSnapshotJson` snapshot above; the
// per-field accessors were removed with AIRFERRY_NATIVE_ABI_VERSION 2.

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

#[cfg(target_os = "android")]
fn android_log(msg: &str) {
    extern "C" {
        fn __android_log_write(prio: i32, tag: *const u8, text: *const u8) -> i32;
    }
    const ANDROID_LOG_ERROR: i32 = 6;
    static TAG: &[u8] = b"airferry\0";
    let mut buf: Vec<u8> = Vec::with_capacity(msg.len() + 1);
    buf.extend_from_slice(msg.as_bytes());
    buf.push(0);
    unsafe {
        __android_log_write(ANDROID_LOG_ERROR, TAG.as_ptr(), buf.as_ptr());
    }
}

#[cfg(not(target_os = "android"))]
fn android_log(msg: &str) {
    eprintln!("[airferry] {msg}");
}
