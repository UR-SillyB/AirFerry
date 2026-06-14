//! Zstd compression.
//!
//! Only available on native / Android targets. On `wasm32-unknown-unknown` the
//! underlying C library does not compile, so the browser extension performs
//! Zstd compression on the JavaScript side (using the same standard zstd
//! format) before handing the bytes to the Rust core. The format is identical,
//! so bytes compressed on one side decompress correctly on the other.

#![cfg(not(target_arch = "wasm32"))]

use crate::{Error, Result};

/// Default compression level. Matches `zstd::DEFAULT_COMPRESSION_LEVEL`.
pub const DEFAULT_LEVEL: i32 = 3;

/// Compress `data` with zstd at the given level.
pub fn compress(data: &[u8], level: i32) -> Result<Vec<u8>> {
    zstd::encode_all(data, level).map_err(|e| Error::Compress(e.to_string()))
}

/// Decompress zstd-encoded `data`.
pub fn decompress(data: &[u8]) -> Result<Vec<u8>> {
    zstd::decode_all(data).map_err(|e| Error::Compress(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let data: Vec<u8> = (0..40_000).map(|i| (i & 0xff) as u8).collect();
        let c = compress(&data, DEFAULT_LEVEL).unwrap();
        let d = decompress(&c).unwrap();
        assert_eq!(d, data);
    }

    #[test]
    fn compressed_data_shrinks_for_repetitive_input() {
        let data = vec![0xABu8; 10_000];
        let c = compress(&data, DEFAULT_LEVEL).unwrap();
        assert!(c.len() < data.len());
    }
}
