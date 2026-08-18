//! # transfer-engine
//!
//! AirFerry Protocol 2 (AF2) transfer engine with JNI (Android), C-ABI (Windows),
//! and WASM (Browser) bindings.

#![cfg_attr(
    not(any(feature = "jni", feature = "cffi", feature = "wasm")),
    forbid(unsafe_code)
)]

pub mod ingest_status;
pub mod progress;
pub mod receiver;
pub mod time;

#[cfg(all(feature = "jni", target_os = "android"))]
pub mod jni;
#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub mod wasm;
#[cfg(feature = "cffi")]
pub mod cffi;

pub use af2::*;
pub use progress::{Progress, Stats};
pub use receiver::ReceiverSession;
