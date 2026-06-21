//! # raptorq-core
//!
//! Thin, opinionated wrapper over the [`raptorq`](https://crates.io/crates/raptorq)
//! crate (RFC 6330 RaptorQ) that exposes a simple symbol-oriented API suitable
//! for the AirFerry optical channel.
//!
//! Design goals:
//! - **Pure logic, no I/O** — works identically compiled to WASM (browser
//!   extension) and to an Android native library (JNI).
//! - **Symbol granularity** — the caller deals in `(sbn, esi, symbol_bytes)`
//!   triples, which map 1:1 onto QR frame payloads.
//! - **Tolerant decoding** — accept symbols in any order, with duplicates,
//!   holes, or extra repair symbols; reconstruction succeeds as soon as enough
//!   independent symbols for a source block arrive.
//!
//! This crate intentionally hides the underlying `Encoder`/`Decoder`/OTI types
//! behind a stable surface so the rest of the system depends only on these
//! types.

#![forbid(unsafe_code)]

mod config;
mod encoder;
mod decoder;
mod symbol;
mod meta;

pub use config::Config;
pub use encoder::Encoder;
pub use decoder::Decoder;
pub use meta::{ObjectMeta, SourceBlockMeta};
pub use symbol::{Symbol, SymbolId};

/// Errors returned by the codec.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("data is empty")]
    EmptyData,
    #[error("symbol size must be > 0")]
    InvalidSymbolSize,
    #[error("source block {sbn} out of range (have {total})")]
    BlockOutOfRange { sbn: u32, total: u32 },
    #[error("source block {sbn} is not yet decodable (need more symbols)")]
    NotDecodable { sbn: u32 },
    #[error("symbol (sbn={sbn}, esi={esi}) does not belong to this object")]
    UnknownSymbol { sbn: u32, esi: u32 },
}

pub(crate) type Result<T> = core::result::Result<T, Error>;
