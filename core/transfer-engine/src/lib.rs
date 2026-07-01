//! # transfer-engine
//!
//! Orchestrates an AirFerry session end-to-end:
//!
//! - [`SenderSession`] holds the (already compressed) payload, owns a
//!   `raptorq-core` encoder, and produces a stream of [`Frame`]s. It
//!   interleaves source symbols with repair symbols to reach a target
//!   redundancy ratio, and loops forever so a receiver can rejoin at any time.
//! - [`ReceiverSession`] ingests decoded QR payloads as frames, feeds the
//!   RaptorQ decoder, tracks per-block progress, and reassembles the file once
//!   complete. Checkpoint via [`ReceiverSession::save_state`] /
//!   [`ReceiverSession::restore`] and [`ResumeState`] (JSON when `serde` is on).
//!
//! Compression is intentionally **outside** this engine: the caller compresses
//! with Zstd (native/Android via `qr-protocol`, or JS-side on the browser) and
//! hands the compressed bytes in. This keeps the engine target-agnostic.

// `cffi` (Windows/.NET P/Invoke, like `jni`) takes raw pointers across the FFI
// boundary, so it must be exempt from `forbid(unsafe_code)` along with `jni`.
#![cfg_attr(not(any(feature = "jni", feature = "cffi")), forbid(unsafe_code))]

pub mod sender;
pub mod receiver;
pub mod progress;
pub mod resume;
pub mod descriptor;
pub mod time;

// Platform bindings are gated on BOTH their feature flag AND their target, so
// that `cargo build --all-features` on the dev host (macOS/linux) does not try to
// compile the wasm module without wasm-bindgen (only present under
// `target_arch = "wasm32"`) or the jni module without the `jni` crate (only
// present under `target_os = "android"`). The feature flag remains the on/off
// switch the build matrix controls; the target gate just keeps non-portable
// code out of foreign targets.
#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub mod wasm;
#[cfg(all(feature = "jni", target_os = "android"))]
pub mod jni;
// Plain C ABI for the Windows client (.NET P/Invoke). No platform gate: the
// binding is pure C (`extern "C"`) with no host-specific dependency, so it
// compiles on any target the host chooses to build the DLL on. The `cffi`
// feature remains the on/off switch the build matrix controls.
#[cfg(feature = "cffi")]
pub mod cffi;

pub use progress::{Progress, Stats};
pub use receiver::ReceiverSession;
pub use sender::{SenderConfig, SenderSession};
pub use resume::ResumeState;
pub use descriptor::{DescriptorInfo, FileMeta};

// Re-export the wire-frame helpers so downstream code (tests, JNI host, the
// browser bridge) can parse/validate frames without depending on qr-protocol
// directly.
pub use qr_protocol::{Frame, FrameHeader, FLAG_DESCRIPTOR};
pub use raptorq_core::ObjectMeta;
/// Parse + validate a frame from its wire bytes (magic + double CRC).
pub fn qr_protocol_frame_from_bytes(bytes: &[u8]) -> Result<Frame> {
    Ok(Frame::from_bytes(bytes)?)
}
/// The descriptor-flag bit, re-exported for convenience.
pub const FLAG_DESCRIPTOR_BIT: u8 = FLAG_DESCRIPTOR;

/// Errors raised by the engine.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("raptorq error: {0}")]
    Raptorq(#[from] raptorq_core::Error),
    #[error("protocol error: {0}")]
    Protocol(#[from] qr_protocol::Error),
    #[error("no payload set")]
    NoPayload,
    #[error("session not yet initialized (no metadata received)")]
    NotInitialized,
    #[error("session id mismatch: expected {expected}, got {got}")]
    SessionMismatch { expected: u128, got: u128 },
    #[error("object already complete")]
    AlreadyComplete,
    #[error("invalid redundancy percentage: {0} (must be between 5 and 50)")]
    InvalidRedundancy(u8),
    #[error("compression error: {0}")]
    Compress(String),
}

pub(crate) type Result<T> = core::result::Result<T, Error>;
