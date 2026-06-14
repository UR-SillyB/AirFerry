//! Android JNI bindings for the receiver side.
//!
//! Uses the official `jni` crate (correct JNIEnv ABI across all Android
//! versions / vendors / ART implementations) with `extern "system"` — the
//! correct calling convention for JNI native methods on 64-bit Android.

#![cfg(feature = "jni")]

use crate::receiver::{derive_meta_from_totals, ReceiverSession};
use crate::Progress;
use jni::objects::{JByteArray, JClass};
use jni::sys::{jint, jlong};
use jni::JNIEnv;
use qr_protocol::frame::SessionIdRaw;

#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverCreate(
    _env: JNIEnv,
    _class: JClass,
    session_id_lo: jlong,
    session_id_hi: jlong,
    total_blocks: jint,
    total_symbols: jint,
    symbol_size: jint,
) -> jlong {
    let sid: SessionIdRaw = ((session_id_hi as u128) << 64) | session_id_lo as u128;
    let meta = derive_meta_from_totals(
        total_blocks as u32,
        total_symbols as u32,
        symbol_size as u32,
    );
    let session = ReceiverSession::new(sid, meta);
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

#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverIngest(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    frame_bytes: JByteArray,
    out_buf: JByteArray,
) -> jint {
    if handle == 0 {
        return 0;
    }
    let frame_vec: Vec<u8> = match env.convert_byte_array(&frame_bytes) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let session = unsafe { &mut *(handle as *mut ReceiverSession) };
    let written: usize = match qr_protocol::Frame::from_bytes(&frame_vec) {
        Ok(frame) => {
            let _ = session.ingest(frame);
            let json = progress_json(&session.progress());
            let mut buf = json.into_bytes();
            buf.push(0);
            let i8_buf: &[i8] = unsafe {
                std::slice::from_raw_parts(buf.as_ptr() as *const i8, buf.len())
            };
            match env.set_byte_array_region(&out_buf, 0, i8_buf) {
                Ok(_) => buf.len().saturating_sub(1),
                Err(_) => 0,
            }
        }
        Err(e) => {
            android_log(&format!("frame rejected: {e:?}"));
            0
        }
    };
    written as jint
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

#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverAssembledLength(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jint {
    if handle == 0 {
        return 0;
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    session.assemble().map(|d| d.len() as jint).unwrap_or(0)
}

#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverAssemble(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    out_buf: JByteArray,
) -> jint {
    if handle == 0 {
        return 0;
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    let Some(data) = session.assemble() else {
        return 0;
    };
    match env.set_byte_array_region(&out_buf, 0, unsafe {
        std::slice::from_raw_parts(data.as_ptr() as *const i8, data.len())
    }) {
        Ok(_) => data.len() as jint,
        Err(_) => 0,
    }
}

// ===== File metadata accessors =====
// Kotlin reads these after a descriptor frame arrives to display the filename,
// original size, and verify CRC32.

/// Returns the original filename as a Java String (or empty if unknown).
#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverFileName(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jni::sys::jstring {
    use jni::objects::JString;
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
#[no_mangle]
pub extern "system" fn Java_com_easytransfer_app_nativelib_NativeBridge_receiverCrc32(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jint {
    if handle == 0 {
        return 0;
    }
    let session = unsafe { &*(handle as *const ReceiverSession) };
    session.file_meta().crc32 as jint
}

fn progress_json(p: &Progress) -> String {
    format!(
        r#"{{"decoded_symbols":{},"total_symbols":{},"received_symbols":{},"frames_seen":{},"frames_dropped":{},"frames_corrupt":{},"decoded_blocks":{},"total_blocks":{},"decoded_fraction":{:.4},"loss_ratio":{:.4},"complete":{},"meta_confirmed":{}}}"#,
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
        p.meta_confirmed
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
