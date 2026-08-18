//! # qr-protocol
//!
//! Compression and QR matrix rendering for AirFerry.
//!
//! ## Modules
//! - [`compress`] — Zstd / Xz compression algorithms.
//! - [`qr_render`] — Render byte frames to QR module matrices via `fast_qr`.

#![forbid(unsafe_code)]

pub mod compress;
pub mod qr_render;

/// Errors produced by this crate.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("compression error: {0}")]
    Compress(String),
    #[error("buffer too short: need {need}, have {have}")]
    BufferTooShort { need: usize, have: usize },
}

pub(crate) type Result<T> = core::result::Result<T, Error>;
