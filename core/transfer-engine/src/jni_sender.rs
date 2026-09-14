//! Android JNI bindings for the sender side.
//!
//! Thin glue over [`crate::sender_host`] (which holds all logic and is
//! unit-tested on every host). Mirrors the `SenderSessionWasm` surface
//! (`wasm.rs`) 1:1 so the Android host drives the exact same protocol path
//! as the web sender — no wire-format logic lives here (SPEC §9).
//!
//! ## Handle model
//! Same as the receiver side (`jni.rs`): a heap-allocated session whose raw
//! pointer crosses as an opaque `jlong`, released by `senderDestroy`. Handles
//! are NOT thread-safe — the Kotlin host serializes render-thread and
//! staging-coroutine calls with one lock.
//!
//! ## Error signalling
//! Failures raise `java.lang.IllegalStateException` (pending exception on
//! return). The playlist `ChunkNotStaged` marker is thrown with the message
//! `AF2_CHUNK_NOT_STAGED:<index>` — identical to the WASM binding's rejection
//! string, so hosts share one parsing rule.

#![cfg(feature = "jni")]

use crate::sender_host::{
    encode_chunk_balanced_packed, parse_hash_table, plan_chunks_json, NextQrError, SenderSession,
};
use af2::SenderConfig;
use jni::objects::{JByteArray, JClass, JLongArray, JObject, JObjectArray, JString};
use jni::sys::{jboolean, jint, jlong};
use jni::JNIEnv;

/// Throw IllegalStateException; the caller must return its sentinel
/// immediately (if the throw itself fails an exception is already pending).
fn throw(env: &mut JNIEnv, msg: &str) {
    let _ = env.throw_new("java/lang/IllegalStateException", msg);
}

/// Extract `(kind, path, size)` triples from the parallel-array form the
/// Kotlin host uses (avoids JSON parsing — this crate is serde-free).
/// `None` means an exception is already pending on `env`.
fn read_metas(
    env: &mut JNIEnv,
    kinds: &JByteArray,
    paths: &JObjectArray,
    sizes: &JLongArray,
) -> Option<Vec<(u8, String, u64)>> {
    let kinds_vec = env.convert_byte_array(kinds).ok()?;
    let n = env.get_array_length(paths).ok()? as usize;
    let sizes_len = env.get_array_length(sizes).ok()? as usize;
    if kinds_vec.len() != n || sizes_len != n {
        throw(
            env,
            &format!(
                "sender meta arrays disagree: kinds={}, paths={}, sizes={}",
                kinds_vec.len(),
                n,
                sizes_len
            ),
        );
        return None;
    }
    // Bound n BEFORE any with_capacity/iteration derived from it (the wire
    // Manifest itself caps at af2::manifest::MAX_ENTRIES — 4096).
    if n > af2::manifest::MAX_ENTRIES {
        throw(
            env,
            &format!("sender meta arrays exceed the entry cap: {n} > {}", af2::manifest::MAX_ENTRIES),
        );
        return None;
    }
    let mut sizes_vec = vec![0 as jlong; n];
    env.get_long_array_region(sizes, 0, &mut sizes_vec).ok()?;
    let mut metas = Vec::with_capacity(n);
    for i in 0..n {
        let obj: JObject = env.get_object_array_element(paths, i as jint).ok()?;
        let jstr = JString::from(obj);
        let path: String = match env.get_string(&jstr) {
            Ok(s) => s.into(),
            Err(_) => return None,
        };
        // Every get_object_array_element creates a NEW local ref; the default
        // ART local table is ~512 entries, so a >512-file send overflows it
        // and aborts the VM. Release each element as soon as it's copied out.
        let _ = env.delete_local_ref(jstr);
        let size = sizes_vec[i];
        if size < 0 {
            throw(env, &format!("sender meta[{i}] has negative size {size}"));
            return None;
        }
        metas.push((kinds_vec[i], path, size as u64));
    }
    Some(metas)
}

fn session_mut(handle: jlong) -> Option<&'static mut SenderSession> {
    // Registry-backed liveness: null, destroyed, and forged handles all
    // return None before the raw pointer cast (ffi_handle module).
    if !crate::ffi_handle::is_live(handle as *const SenderSession) {
        None
    } else {
        Some(unsafe { &mut *(handle as *mut SenderSession) })
    }
}

fn string_or_null(env: &mut JNIEnv, s: &str) -> jni::sys::jstring {
    match env.new_string(s) {
        Ok(v) => v.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

// ===== prep helpers =====

/// Canonical chunk layout as `{"chunks":[[item,start,len,...],...]}` (flat
/// triples per chunk). Throws IllegalStateException on bad input.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_senderPlanChunks(
    mut env: JNIEnv,
    _class: JClass,
    kinds: JByteArray,
    paths: JObjectArray,
    sizes: JLongArray,
    chunk_raw_size: jint,
) -> jni::sys::jstring {
    let metas = match read_metas(&mut env, &kinds, &paths, &sizes) {
        Some(m) => m,
        None => return std::ptr::null_mut(), // exception already pending
    };
    match plan_chunks_json(&metas, chunk_raw_size as u32) {
        Ok(json) => string_or_null(&mut env, &json),
        Err(e) => {
            throw(&mut env, &e);
            std::ptr::null_mut()
        }
    }
}

/// Streaming BLAKE3 hasher: create → update* → digest (digest DESTROYS the
/// handle). Used by the host's prep pass so file bytes stream through 1 MiB
/// slices instead of materializing in memory.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_blake3Create(
    _env: JNIEnv,
    _class: JClass,
) -> jlong {
    crate::ffi_handle::register(Box::into_raw(Box::new(af2::id::new_hasher())), 0) as jlong
}

#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_blake3Update(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    bytes: JByteArray,
) {
    if !crate::ffi_handle::is_live(handle as *const af2::id::Blake3Hasher) {
        throw(&mut env, "blake3Update on unknown handle");
        return;
    }
    let data = match env.convert_byte_array(&bytes) {
        Ok(d) => d,
        Err(_) => return, // OOM exception pending
    };
    let hasher = unsafe { &mut *(handle as *mut af2::id::Blake3Hasher) };
    hasher.update(&data);
}

/// Finalize and DESTROY the hasher. Returns the 32-byte digest, or null.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_blake3Digest(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jni::sys::jbyteArray {
    // Withdraw from the registry first: a double-digest or forged handle is
    // a null result instead of a second free of the same allocation.
    if crate::ffi_handle::take(handle as *mut af2::id::Blake3Hasher).is_none() {
        throw(&mut env, "blake3Digest on unknown handle");
        return std::ptr::null_mut();
    }
    let hasher = unsafe { Box::from_raw(handle as *mut af2::id::Blake3Hasher) };
    let digest = hasher.finalize();
    match env.byte_array_from_slice(digest.as_bytes()) {
        Ok(a) => a.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// `encode_chunk_balanced` packed as `[codec_id][data...]`.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_encodeChunkBalanced(
    env: JNIEnv,
    _class: JClass,
    raw: JByteArray,
    channel_bps: jlong,
    force_full: jboolean,
) -> jni::sys::jbyteArray {
    let data = match env.convert_byte_array(&raw) {
        Ok(d) => d,
        Err(_) => return std::ptr::null_mut(),
    };
    let packed = encode_chunk_balanced_packed(&data, channel_bps.max(0) as u64, force_full != 0);
    match env.byte_array_from_slice(&packed) {
        Ok(a) => a.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

// ===== session lifecycle =====

/// Streamed (bounded-memory) sender build. `content_hashes` and
/// `chunk_hashes` are packed 32×N tables (see `sender_host::parse_hash_table`);
/// `content_hashes` aligns positionally with the meta arrays, `chunk_hashes`
/// with the plan from `senderPlanChunks`. Returns the session handle, or 0
/// with a pending exception on failure.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_senderBuildStreamed(
    mut env: JNIEnv,
    _class: JClass,
    kinds: JByteArray,
    paths: JObjectArray,
    sizes: JLongArray,
    content_hashes: JByteArray,
    chunk_hashes: JByteArray,
    symbol_size: jint,
    chunk_raw_size: jint,
    redundancy_pct: jint,
) -> jlong {
    let metas = match read_metas(&mut env, &kinds, &paths, &sizes) {
        Some(m) => m,
        None => return 0,
    };
    let content_vec = match env.convert_byte_array(&content_hashes) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let chunk_vec = match env.convert_byte_array(&chunk_hashes) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let content_table = match parse_hash_table(&content_vec) {
        Ok(t) => t,
        Err(e) => {
            throw(&mut env, &e);
            return 0;
        }
    };
    if content_table.len() != metas.len() {
        throw(
            &mut env,
            &format!(
                "content hash count {} != meta count {}",
                content_table.len(),
                metas.len()
            ),
        );
        return 0;
    }
    let chunk_table = match parse_hash_table(&chunk_vec) {
        Ok(t) => t,
        Err(e) => {
            throw(&mut env, &e);
            return 0;
        }
    };
    let metas_with_hash: Vec<(u8, String, u64, [u8; 32])> = metas
        .into_iter()
        .zip(content_table)
        .map(|((kind, path, size), hash)| (kind, path, size, hash))
        .collect();
    if symbol_size <= 0 || chunk_raw_size <= 0 || !(0..=100).contains(&redundancy_pct) {
        throw(
            &mut env,
            &format!(
                "bad sender config: symbol_size={symbol_size} chunk_raw_size={chunk_raw_size} redundancy_pct={redundancy_pct}"
            ),
        );
        return 0;
    }
    let config = SenderConfig {
        symbol_size: symbol_size as usize,
        chunk_raw_size: chunk_raw_size as u32,
        redundancy_pct: redundancy_pct as u8,
    };
    match SenderSession::new_streamed(metas_with_hash, config, chunk_table) {
        Ok(session) => crate::ffi_handle::register(Box::into_raw(Box::new(session)), 0) as jlong,
        Err(e) => {
            throw(&mut env, &e);
            0
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_senderDestroy(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    // Withdraw from the registry first: a double-destroy or forged handle is
    // a silent no-op instead of a second free of the same allocation.
    if crate::ffi_handle::take(handle as *mut SenderSession).is_some() {
        unsafe { drop(Box::from_raw(handle as *mut SenderSession)) };
    }
}

// ===== play-time hot path =====

/// Pull the next QR batch. Returns the packed buffer
/// (`u32le count`, then per tile `u32le side` + `side²` 0/1 bytes) or null
/// with a pending exception: `AF2_CHUNK_NOT_STAGED:<index>` when the playlist
/// hit an unstaged chunk (stage it and retry), otherwise a failure message.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_senderNextQr(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    count: jint,
) -> jni::sys::jbyteArray {
    let Some(session) = session_mut(handle) else {
        throw(&mut env, "senderNextQr on null handle");
        return std::ptr::null_mut();
    };
    match session.next_qr_batch(count.max(1) as u32) {
        Ok(buf) => match env.byte_array_from_slice(&buf) {
            Ok(a) => a.into_raw(),
            Err(_) => std::ptr::null_mut(),
        },
        Err(NextQrError::NotStaged(index)) => {
            throw(&mut env, &format!("AF2_CHUNK_NOT_STAGED:{index}"));
            std::ptr::null_mut()
        }
        Err(NextQrError::Failed(e)) => {
            throw(&mut env, &e);
            std::ptr::null_mut()
        }
    }
}

/// Stage one encoded chunk. `raw_hash` is the host-precomputed BLAKE3 of the
/// RAW chunk (32 bytes; empty array = let the core hash). Returns false with
/// a pending exception on validation failure.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_senderStageChunk(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    index: jint,
    codec_id: jint,
    bytes: JByteArray,
    raw_hash: JByteArray,
) -> jboolean {
    let Some(session) = session_mut(handle) else {
        throw(&mut env, "senderStageChunk on null handle");
        return 0;
    };
    if index < 0 {
        throw(
            &mut env,
            &format!("senderStageChunk has negative index {index}"),
        );
        return 0;
    }
    if !(0..=u8::MAX as jint).contains(&codec_id) {
        throw(
            &mut env,
            &format!("senderStageChunk has invalid codec {codec_id}"),
        );
        return 0;
    }
    let data = match env.convert_byte_array(&bytes) {
        Ok(d) => d,
        Err(_) => return 0,
    };
    let hash_vec = match env.convert_byte_array(&raw_hash) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let digest = match hash_vec.len() {
        0 => None,
        32 => {
            let mut d = [0u8; 32];
            d.copy_from_slice(&hash_vec);
            Some(d)
        }
        len => {
            throw(
                &mut env,
                &format!("senderStageChunk raw_hash must be empty or 32 bytes, got {len}"),
            );
            return 0;
        }
    };
    match session.stage_chunk(index as u32, codec_id as u8, data, digest) {
        Ok(()) => 1,
        Err(e) => {
            throw(&mut env, &e);
            0
        }
    }
}

/// Playlist position hint (-1 during bootstrap).
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_senderCurrentChunkIndex(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jint {
    match session_mut(handle) {
        Some(s) => s.current_chunk_index().map(|i| i as jint).unwrap_or(-1),
        None => -1,
    }
}

/// 1-based broadcast epoch (0 on null handle).
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_senderEpoch(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jint {
    match session_mut(handle) {
        Some(s) => s.epoch() as jint,
        None => 0,
    }
}

#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_senderIsStaged(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    index: jint,
) -> jboolean {
    if index < 0 {
        return 0;
    }
    match session_mut(handle) {
        Some(s) => s.is_staged(index as u32) as jboolean,
        None => 0,
    }
}

/// On-demand stats JSON (`frames/fps/throughput_bps/bytes/elapsed_ms`) — call
/// at the UI refresh cadence, not per frame. Null on null handle.
#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_senderStatsJson(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jni::sys::jstring {
    match session_mut(handle) {
        Some(s) => string_or_null(&mut env, &s.stats_json()),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_airferry_app_nativelib_NativeBridge_senderTransferIdHex(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jni::sys::jstring {
    match session_mut(handle) {
        Some(s) => string_or_null(&mut env, &s.transfer_id_hex()),
        None => std::ptr::null_mut(),
    }
}
