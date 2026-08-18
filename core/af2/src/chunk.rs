//! AF2 per-chunk codec (protocol 2, §10).
//!
//! Each Raw Chunk is independently coded RAW / Zstd / Xz. The **strictly
//! smaller** invariant is dual-end: a compressed tag is only legal when the
//! encoded bytes are strictly shorter than raw; receivers reject violations.
//! Decompression output must equal the chunk's canonical raw length exactly.
//!
//! The bounded-decompression guards reuse qr-protocol's zstd window clamp
//! (`ZSTD_WINDOW_LOG_MAX=23`) and XZ memory caps via the same decoder stack —
//! one implementation, three ends.

use crate::meta::{CODEC_RAW, CODEC_XZ, CODEC_ZSTD};

pub const MAX_ZSTD_WINDOW_LOG: u32 = 23;
pub const MAX_XZ_DICT_BYTES: u64 = 32 << 20;
pub const MAX_XZ_MEM_BYTES: u64 = 128 << 20;

#[derive(Debug, thiserror::Error)]
pub enum ChunkError {
    #[error("chunk: encoded ({encoded}) is not strictly smaller than raw ({raw})")]
    NotStrictlySmaller { encoded: usize, raw: usize },
    #[error("chunk: decompressed size mismatch: expected {expected}, got {got}")]
    SizeMismatch { expected: usize, got: usize },
    #[error("chunk: decompression failed: {0}")]
    Decompress(String),
    #[error("chunk: unknown codec id {0}")]
    UnknownCodec(u8),
}

/// Encode one chunk: try Zstd then Xz, keep a compressed tag ONLY when it is
/// strictly smaller than raw (§10.1). Three-algorithm selection with early
/// exit is a sender POLICY living in the hosts; this is the core primitive.
pub fn encode_chunk(raw: &[u8]) -> (u8, Vec<u8>) {
    // Empty and tiny chunks: compression can never win meaningfully; zstd on
    // empty input still emits a frame header (3 bytes) — strictly larger.
    if raw.len() < 64 {
        return (CODEC_RAW, raw.to_vec());
    }
    if let Ok(z) = qr_protocol::compress::compress(raw, 1) {
        if z.len() < raw.len() {
            return (CODEC_ZSTD, z);
        }
    }
    if let Ok(x) = qr_protocol::compress::compress_with(raw, qr_protocol::compress::COMPRESSION_XZ) {
        if x.len() < raw.len() {
            return (CODEC_XZ, x);
        }
    }
    (CODEC_RAW, raw.to_vec())
}

/// Balanced sender policy (host prep-time pre-encode; SPEC §10.1 keeps the
/// policy out of the wire format). Three rules, calibrated on measured
/// zstd-L1 / xz-preset trade-offs:
///
/// 1. **Sample skip** — compress a 256 KiB prefix with both zstd-L1 and
///    xz-p2; when neither reaches 98%, the chunk is treated as
///    incompressible (media / random) and ships RAW without any full-size
///    attempt. This also removes the wasted play-time codec attempts the
///    lazy fallback performs on media files.
/// 2. **Best of (zstd-L1, xz-p2)** — p2 captures most of xz's ratio at
///    ~7× the encode speed of the standard preset, so it is the default
///    candidate set for compressible chunks.
/// 3. **R-gated escalation** — the standard high-ratio preset runs only when
///    its projected transfer-time saving beats its own encode time
///    (`(rz − 0.8·rx) > channel_bps / P6_ENCODE_BPS`), or unconditionally
///    for single-chunk transfers (`force_full`: bounded wait, biggest
///    relative win).
///
/// `channel_bps` is the sender's playout payload rate (fps × T × QR count);
/// 0 disables escalation entirely.
pub fn encode_chunk_balanced(raw: &[u8], channel_bps: u64, force_full: bool) -> (u8, Vec<u8>) {
    if raw.len() < 64 {
        return (CODEC_RAW, raw.to_vec());
    }
    // Rule 1: sample skip. 4096 keeps the verdict off tiny tail chunks where
    // the sample IS the chunk and the full pass below is cheaper than logic.
    let sample = &raw[..raw.len().min(BALANCED_SAMPLE_BYTES)];
    if sample.len() >= 4096 {
        let sz = qr_protocol::compress::compress(sample, 1).unwrap_or_default();
        let sx = qr_protocol::compress::compress_xz_preset(sample, 2).unwrap_or_default();
        if sz.len() as u64 * 100 >= sample.len() as u64 * BALANCED_SAMPLE_KEEP_PCT
            && sx.len() as u64 * 100 >= sample.len() as u64 * BALANCED_SAMPLE_KEEP_PCT
        {
            return (CODEC_RAW, raw.to_vec());
        }
    }
    // Rule 2: best of zstd-L1 vs xz-p2.
    // An encoder error must degrade to "zstd lost", NEVER to an empty
    // compressed payload: a 0-byte Vec beats RAW on the strictly-smaller
    // check and would sail through every downstream guard as
    // {codec: ZSTD, data: []} — a chunk that can never be decoded (OTI F=0).
    let z_vec = qr_protocol::compress::compress(raw, 1).ok();
    let mut best = (CODEC_RAW, raw.to_vec());
    if let Some(z) = &z_vec {
        if z.len() < best.1.len() {
            best = (CODEC_ZSTD, z.clone());
        }
    }
    if let Ok(x2) = qr_protocol::compress::compress_xz_preset(raw, 2) {
        if x2.len() < best.1.len() {
            best = (CODEC_XZ, x2);
        }
    }
    // Rule 3: escalate to the standard preset when the projected p6 ratio
    // (≈ 0.8 × the p2 ratio, calibrated on text/JSON/base64 corpora) saves
    // more channel time than the encode costs.
    let r_best = best.1.len() as f64 / raw.len() as f64;
    let r_zstd = if best.0 == CODEC_ZSTD {
        r_best
    } else {
        // zstd lost or failed; clamp its measured ratio at 1.0 (the
        // escalation is measured against the worst case it replaces).
        z_vec
            .as_deref()
            .map_or(1.0, |z| z.len() as f64 / raw.len() as f64)
            .min(1.0)
    };
    let escalate = force_full
        || (channel_bps > 0
            && r_zstd - P6_RATIO_FACTOR * r_best > channel_bps as f64 / P6_ENCODE_BPS);
    if escalate {
        if let Ok(x6) = qr_protocol::compress::compress_xz_standard(raw) {
            if x6.len() < best.1.len() {
                best = (CODEC_XZ, x6);
            }
        }
    }
    best
}

/// Rule-1 sample size (prefix of the chunk).
pub const BALANCED_SAMPLE_BYTES: usize = 256 * 1024;
/// Rule-1 keep threshold in percent: a sample result at or above this share
/// of the sample length counts as "did not compress".
const BALANCED_SAMPLE_KEEP_PCT: u64 = 98;
/// Rule-3 calibration: standard-preset output ≈ this factor × the p2 output
/// (measured 0.75 JSON / 0.94 base64 / ~1.0 text on the bench corpora).
const P6_RATIO_FACTOR: f64 = 0.8;
/// Rule-3 calibration: conservative wasm32 standard-preset encode throughput
/// in bytes/second (native measures 3.3–12 MB/s; wasm ≈ 2.5× slower).
const P6_ENCODE_BPS: f64 = 1_200_000.0;

/// Decode one chunk with full bounded verification. `expected_raw_len` is the
/// canonical chunk length (from ROOT); the output must match it exactly.
/// `chunk_raw_size` (also from ROOT) bounds the XZ declared dictionary
/// (§10.1: dict ≤ min(chunk_raw_size, 32 MiB)).
///
/// The §10.1 wire structure (single frame/stream, no trailing bytes, bounded
/// window/dict) is enforced by qr-protocol's decoder stack on every target —
/// native (libzstd/liblzma) and wasm32 (ruzstd/lzma-rs) alike.
pub fn decode_chunk(
    codec_id: u8,
    encoded: &[u8],
    expected_raw_len: usize,
    chunk_raw_size: u32,
) -> Result<Vec<u8>, ChunkError> {
    match codec_id {
        CODEC_RAW => {
            if encoded.len() != expected_raw_len {
                return Err(ChunkError::SizeMismatch {
                    expected: expected_raw_len,
                    got: encoded.len(),
                });
            }
            Ok(encoded.to_vec())
        }
        CODEC_ZSTD | CODEC_XZ => decode_compressed(codec_id, encoded, expected_raw_len, chunk_raw_size),
        other => Err(ChunkError::UnknownCodec(other)),
    }
}

/// Compressed-tag path shared by both targets: the strictly-smaller
/// invariant, then qr-protocol's §10.1-bounded decoder.
fn decode_compressed(
    codec_id: u8,
    encoded: &[u8],
    expected_raw_len: usize,
    chunk_raw_size: u32,
) -> Result<Vec<u8>, ChunkError> {
    // Reject a compressed tag that is NOT strictly smaller than the
    // canonical raw length (protocol invariant, enforced on receipt).
    if encoded.len() >= expected_raw_len {
        return Err(ChunkError::NotStrictlySmaller {
            encoded: encoded.len(),
            raw: expected_raw_len,
        });
    }
    let tag = if codec_id == CODEC_ZSTD {
        qr_protocol::compress::COMPRESSION_ZSTD
    } else {
        qr_protocol::compress::COMPRESSION_XZ
    };
    let out = qr_protocol::compress::decompress_chunk(
        encoded,
        tag,
        // Exact expected length: anything longer is a violation.
        expected_raw_len,
        chunk_raw_size,
    )
    .map_err(|e| ChunkError::Decompress(e.to_string()))?;
    if out.len() != expected_raw_len {
        return Err(ChunkError::SizeMismatch {
            expected: expected_raw_len,
            got: out.len(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pseudo_random(n: usize, seed: u64) -> Vec<u8> {
        let mut state = seed;
        let mut v = Vec::with_capacity(n);
        while v.len() < n {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            v.extend_from_slice(&state.to_le_bytes());
        }
        v.truncate(n);
        v
    }

    /// Round-trip chunk_raw_size used by the tests below.
    const CRS: u32 = 8 << 20;

    #[test]
    fn round_trip_all_codecs_and_boundaries() {
        // {empty, 1B, symbol-ish 1024, chunk-ish} × {incompressible, compressible}.
        let cases: Vec<Vec<u8>> = vec![
            vec![],
            vec![0xAB],
            pseudo_random(1024, 1),       // incompressible
            vec![0x00; 1024],             // highly compressible
            pseudo_random(65_536, 2),     // ~ a symbol-size incompressible
            vec![b'A'; 65_536],           // compressible
        ];
        for raw in cases {
            let (codec, encoded) = encode_chunk(&raw);
            let out = decode_chunk(codec, &encoded, raw.len(), CRS).unwrap();
            assert_eq!(out, raw);
            if codec != CODEC_RAW {
                assert!(encoded.len() < raw.len(), "strictly-smaller invariant");
            }
        }
    }

    #[test]
    fn rejects_bombs_and_mislabelled_sizes() {
        // A compressed tag whose encoded size >= canonical raw length.
        let raw = vec![0u8; 4096];
        let (_, _encoded) = encode_chunk(&raw); // RAW (compression wins? zeros compress well)
        // zeros DO compress; craft the violation directly instead:
        let z = qr_protocol::compress::compress(&raw, 1).unwrap();
        assert!(z.len() < raw.len());
        // Claim canonical raw == z.len() - 1 (smaller than encoded) → violation.
        assert!(matches!(
            decode_chunk(CODEC_ZSTD, &z, z.len() - 1, CRS),
            Err(ChunkError::NotStrictlySmaller { .. })
        ));
        // Claim a longer canonical length → exact-size mismatch after decode.
        assert!(matches!(
            decode_chunk(CODEC_ZSTD, &z, raw.len() + 1, CRS),
            Err(ChunkError::SizeMismatch { .. })
        ));
        // Decompression bomb: tiny zstd of huge zeros capped at expected len.
        let bomb = qr_protocol::compress::compress(&vec![0u8; 1 << 22], 1).unwrap();
        assert!(matches!(
            decode_chunk(CODEC_ZSTD, &bomb, 1024, CRS),
            Err(ChunkError::SizeMismatch { .. }) | Err(ChunkError::Decompress(_))
        ));
    }

    #[test]
    fn rejects_xz_dict_above_chunk_raw_size() {
        // §10.1: declared dictionary ≤ min(chunk_raw_size, 32 MiB). Build a
        // stream whose dict (8 MiB at preset 6) exceeds a 1 MiB chunking.
        let raw = vec![0x5Au8; 300_000];
        let x = qr_protocol::compress::compress_with(&raw, qr_protocol::compress::COMPRESSION_XZ)
            .unwrap();
        assert!(x.len() < raw.len());
        // The encoder clamps dict ≤ input length (here 256 KiB, the largest
        // legal size ≤ 300 KB), so a 1 MiB chunking cap passes — but a
        // fabricated 128 KiB cap (below the declared dict) must be rejected.
        assert!(decode_chunk(CODEC_XZ, &x, raw.len(), 1 << 20).is_ok());
        let small_cap = 128 << 10;
        assert!(matches!(
            decode_chunk(CODEC_XZ, &x, raw.len(), small_cap),
            Err(ChunkError::Decompress(_))
        ));
    }

    /// Deterministic xorshift stream for the incompressible corpora.
    fn pseudorandom(len: usize) -> Vec<u8> {
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut out = Vec::with_capacity(len);
        while out.len() < len {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            out.extend_from_slice(&x.to_le_bytes());
        }
        out.truncate(len);
        out
    }

    fn repetitive_text(len: usize) -> Vec<u8> {
        let paragraph = b"the quick brown fox jumps over the lazy dog; compression finds repetition. ";
        let mut out = Vec::with_capacity(len);
        while out.len() < len {
            out.extend_from_slice(paragraph);
        }
        out.truncate(len);
        out
    }

    #[test]
    fn balanced_policy_skips_incompressible() {
        // Rule 1: media-like chunk — both sample codecs fail the 98% gate and
        // the chunk ships RAW without any full-size attempt (even force_full
        // cannot help, the standard preset would not shrink it either).
        let raw = pseudorandom(512 * 1024);
        for force in [false, true] {
            let (codec, data) = encode_chunk_balanced(&raw, 200_000, force);
            assert_eq!(codec, CODEC_RAW);
            assert_eq!(data.len(), raw.len());
        }
    }

    #[test]
    fn balanced_policy_compresses_repetitive() {
        let raw = repetitive_text(512 * 1024);
        let (codec, data) = encode_chunk_balanced(&raw, 0, false);
        assert_ne!(codec, CODEC_RAW, "repetitive text must get a codec");
        assert!(data.len() * 3 < raw.len(), "ratio must be well under 1/3");
        // The chosen encoding must survive the §10.1 decode gate.
        let back = decode_chunk(codec, &data, raw.len(), 8 << 20).unwrap();
        assert_eq!(back, raw);
    }

    #[test]
    fn balanced_policy_force_full_never_worse() {
        // Rule 3 escalation only ever replaces the candidate via min(), so a
        // forced escalation result can never be larger than the unforced one.
        let raw = repetitive_text(256 * 1024);
        let (_, relaxed) = encode_chunk_balanced(&raw, u64::MAX, false);
        let (_, forced) = encode_chunk_balanced(&raw, 0, true);
        assert!(forced.len() <= relaxed.len());
    }

    #[test]
    fn balanced_policy_fast_channel_skips_escalation() {
        // Rule 3 with an unreachable channel rate never escalates: the result
        // is exactly best-of(zstd-L1, xz-p2).
        let raw = repetitive_text(256 * 1024);
        let (codec, data) = encode_chunk_balanced(&raw, u64::MAX, false);
        let z = qr_protocol::compress::compress(&raw, 1).unwrap();
        let x2 = qr_protocol::compress::compress_xz_preset(&raw, 2).unwrap();
        let (expect_len, expect_codec) = if x2.len() < z.len() {
            (x2.len(), CODEC_XZ)
        } else {
            (z.len(), CODEC_ZSTD)
        };
        assert_eq!(codec, expect_codec);
        assert_eq!(data.len(), expect_len);
    }
}
