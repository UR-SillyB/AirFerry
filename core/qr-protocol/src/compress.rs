//! Unified compression interface (Zstd + XZ/LZMA2).
//!
//! Dual-algorithm bounded compression: Zstd (default, fast) and XZ (LZMA2,
//! higher ratio for text). The strictly-smaller invariant is enforced by AF2
//! chunk layers before wire emission. Native builds use C bindings (`zstd` and
//! `xz2`), while `wasm32-unknown-unknown` builds use pure-Rust implementations
//! (`zrip` and `lzma-rust2` for compression, `ruzstd` and `lzma-rs` for
//! decompression). All decode paths enforce the §10.1 wire structure: single
//! frame/stream, no trailing bytes, bounded windows/dictionaries, capped output.

#![cfg_attr(target_arch = "wasm32", allow(dead_code))]

use crate::Error;
use crate::Result;

/// Maximum compression level for small files where compression time is negligible.
/// Using level 22 (maximum) for best compression ratio on typical small files (<10MB).
pub const DEFAULT_LEVEL: i32 = 22;

/// Compression-algorithm tags carried in the descriptor (1 byte, big-endian).
pub const COMPRESSION_NONE: u8 = 0;
pub const COMPRESSION_ZSTD: u8 = 1;
pub const COMPRESSION_XZ: u8 = 2;

/// True for on-wire algorithm tags the stack implements end-to-end.
#[inline]
pub fn is_known_compression_tag(tag: u8) -> bool {
    matches!(tag, COMPRESSION_NONE | COMPRESSION_ZSTD | COMPRESSION_XZ)
}

// ---------------------------------------------------------------------------
// §10.1 wire-format structural checks (shared by native and wasm32 decoders).
// These run BEFORE any third-party decoder sees untrusted bytes.
// ---------------------------------------------------------------------------

/// Decode an xz multibyte integer at `pos`; returns `(value, bytes_consumed)`.
fn read_xz_varint(data: &[u8], pos: usize) -> Option<(u64, usize)> {
    let mut value: u64 = 0;
    let mut i = pos;
    loop {
        let b = *data.get(i)?;
        value = (value << 7) | u64::from(b & 0x7F);
        i += 1;
        if b & 0x80 == 0 {
            return Some((value, i - pos));
        }
        if i - pos >= 9 {
            return None; // xz varints are at most 9 bytes
        }
    }
}

/// LZMA2 dictionary size encoded by the filter property byte
/// (xz-file-format §5.3.2): 40 → the 4 GiB−1 sentinel, otherwise
/// `(2 | (bits & 1)) << (bits >> 1) + 11`.
fn lzma2_dict_from_prop(bits: u8) -> u64 {
    if bits >= 40 {
        0xFFFF_FFFF
    } else {
        (2u64 | u64::from(bits & 1)) << ((u32::from(bits) >> 1) + 11)
    }
}

/// Parse the declared LZMA2 dictionary size out of an `.xz` container's first
/// block header (§10.1: single stream, single LZMA2 filter). Anything that
/// deviates from that minimal legal layout is rejected — the decoder stack
/// must never guess.
pub fn xz_declared_dict_size(data: &[u8]) -> std::result::Result<u64, String> {
    if data.len() < 12 || data[..6] != [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00] {
        return Err("xz: missing stream header magic".into());
    }
    let header_size = (usize::from(data[12]) + 1) * 4;
    if header_size < 8 || data.len() < 12 + header_size {
        return Err("xz: truncated block header".into());
    }
    let flags = data[13];
    if flags & 0x03 != 0 {
        return Err("xz: multi-filter block (only single LZMA2 is legal)".into());
    }
    let mut pos = 14;
    if flags & 0x40 != 0 {
        // Compressed size present.
        let (_, n) = read_xz_varint(data, pos).ok_or("xz: bad compressed-size varint")?;
        pos += n;
    }
    if flags & 0x80 != 0 {
        // Uncompressed size present.
        let (_, n) = read_xz_varint(data, pos).ok_or("xz: bad uncompressed-size varint")?;
        pos += n;
    }
    let (filter_id, n) = read_xz_varint(data, pos).ok_or("xz: bad filter id varint")?;
    pos += n;
    if filter_id != 0x21 {
        return Err(format!("xz: non-LZMA2 filter 0x{filter_id:x}"));
    }
    let (props_len, n) = read_xz_varint(data, pos).ok_or("xz: bad props-size varint")?;
    pos += n;
    if props_len != 1 {
        return Err("xz: LZMA2 props must be exactly 1 byte".into());
    }
    let prop = *data
        .get(pos)
        .ok_or_else(|| "xz: truncated LZMA2 props".to_string())?;
    Ok(lzma2_dict_from_prop(prop))
}

/// Largest legal LZMA2 dictionary size that is ≤ `cap` (used by the encoder
/// so its own streams always satisfy the receiver's declared-dict bound).
/// Legal sizes are `2^n` and `3·2^(n-1)` for n ≥ 12, i.e. exactly the values
/// `lzma2_dict_from_prop` produces; liblzma would otherwise round an
/// arbitrary dict_size UP, potentially past the cap.
fn lzma2_dict_at_most(cap: u64) -> u32 {
    if cap >= 0xFFFF_FFFF {
        return 0xFFFF_FFFF;
    }
    // Walk property bytes from the largest (39) down; the first dict ≤ cap wins.
    for bits in (0..40u8).rev() {
        let dict = lzma2_dict_from_prop(bits);
        if dict <= cap {
            return dict as u32;
        }
    }
    MIN_XZ_DICT_BYTES as u32
}

/// Parse a zstd frame header far enough to check its declared window size
/// against `ZSTD_WINDOW_LOG_MAX`-equivalent bounds (23). Returns false on
/// malformed headers (fail-closed) or oversized windows. `single_segment`
/// frames derive the window from the pledged content size, which the output
/// cap already bounds.
#[cfg(any(target_arch = "wasm32", test))]
fn zstd_window_log_ok(data: &[u8]) -> bool {
    if data.len() < 6 || data[..4] != [0x28, 0xB5, 0x2F, 0xFD] {
        return false;
    }
    let fhd = data[4];
    let single_segment = fhd & 0x20 != 0;
    let mut pos = 5 + [0usize, 1, 2, 4][usize::from(fhd & 0x03)]; // dictID
    let fcs_size = match fhd >> 6 {
        1 => 2,
        2 => 4,
        3 => 8,
        _ if single_segment => 1,
        _ => 0,
    };
    pos += fcs_size;
    if single_segment {
        return true;
    }
    let wd = match data.get(pos) {
        Some(&b) => b,
        None => return false,
    };
    let exp = u32::from(wd >> 3);
    let mantissa = wd & 0x07;
    // window = 2^(10+exp) · (1 + mantissa/8); keep it strictly ≤ 2^23.
    10 + exp < 23 || (10 + exp == 23 && mantissa == 0)
}

/// XZ/LZMA2 preset. The low 5 bits are the compression level (0..=9); bit 31
/// is `LZMA_PRESET_EXTREME` (0x8000_0000), which enables a much slower but
/// higher-ratio search at the given level.
///
/// We use level 6 (the default for xz tools) with the EXTREME flag. Level 9
/// peaks at ~700 MB of memory on the *decoder* side, which OOMs the typical
/// Android JVM heap (256 MB); level 6 keeps the decoder footprint around
/// ~95 MB while still compressing text-heavy payloads well. Dictionary size
/// is additionally clamped per-input by [`xz_dict_at_most`] (§10.1: declared
/// dict ≤ min(chunk_raw_size, 32 MiB)) and bounded on decode by
/// [`XZ_DECODER_MEMORY_LIMIT`] (128 MiB).
#[cfg(not(target_arch = "wasm32"))]
const LZMA_PRESET_EXTREME: u32 = 0x8000_0000;
#[cfg(not(target_arch = "wasm32"))]
const XZ_PRESET: u32 = 6 | LZMA_PRESET_EXTREME;
/// Decoder dictionary/memory ceiling independent of the output byte cap.
#[cfg(not(target_arch = "wasm32"))]
const XZ_DECODER_MEMORY_LIMIT: u64 = 128 * 1024 * 1024;
/// §10.1 absolute declared-dictionary ceiling for XZ (AF2 also tightens it
/// to the transfer's chunk_raw_size on the chunk decode path).
const MAX_XZ_DICT_BYTES: u64 = 32 * 1024 * 1024;
/// Minimum legal LZMA2 dictionary (2^12); smaller declarations round up.
const MIN_XZ_DICT_BYTES: u64 = 4096;

/// Maximum zstd back-reference window (`2^log` bytes) enforced on BOTH sides
/// of this stack (audit L1).
const ZSTD_WINDOW_LOG_MAX: u32 = 23;

/// Build a zstd streaming decoder with the receiver-side window clamp
/// ([`ZSTD_WINDOW_LOG_MAX`]) applied and single-frame mode armed (§10.1:
/// single Frame — no concatenated frames, no skippable/trailing bytes; the
/// caller rejects leftovers). All untrusted-input decode paths must go
/// through this so no `Decoder` is ever constructed unclamped.
#[cfg(not(target_arch = "wasm32"))]
fn zstd_decoder<R: std::io::BufRead>(
    reader: R,
) -> Result<zstd::stream::read::Decoder<'static, R>> {
    let mut dec = zstd::stream::read::Decoder::with_buffer(reader)
        .map_err(|e| Error::Compress(e.to_string()))?;
    dec.window_log_max(ZSTD_WINDOW_LOG_MAX)
        .map_err(|e| Error::Compress(e.to_string()))?;
    Ok(dec.single_frame())
}

/// Native zstd decode with §10.1 structural bounds: single frame, window
/// clamp, output cap, and rejection of any byte trailing the first frame
/// (concatenation / skippable frames / garbage all land here).
#[cfg(not(target_arch = "wasm32"))]
fn zstd_decode_bounded(data: &[u8], max_output: usize) -> Result<Vec<u8>> {
    let mut dec = zstd_decoder(data)?;
    let out = read_capped(&mut dec, max_output)?;
    // R = &[u8]: the slice itself is advanced past exactly the bytes the
    // decoder consumed, so any remainder is trailing data.
    if !dec.get_ref().is_empty() {
        return Err(Error::Compress(
            "trailing bytes after zstd frame (§10.1 single-frame)".into(),
        ));
    }
    Ok(out)
}

/// Native XZ decode with §10.1 structural bounds: declared dictionary ≤
/// `dict_cap`, decode memory ≤ [`XZ_DECODER_MEMORY_LIMIT`], output cap, and
/// exact stream consumption (liblzma's `total_in` — any byte left over is
/// a concatenated stream or trailing garbage).
#[cfg(not(target_arch = "wasm32"))]
fn xz_decode_bounded(data: &[u8], max_output: usize, dict_cap: u64) -> Result<Vec<u8>> {
    let dict = xz_declared_dict_size(data).map_err(Error::Compress)?;
    if dict > dict_cap {
        return Err(Error::Compress(format!(
            "xz declared dictionary {dict} exceeds cap {dict_cap}"
        )));
    }
    let stream = xz2::stream::Stream::new_stream_decoder(XZ_DECODER_MEMORY_LIMIT, 0)
        .map_err(|e| Error::Compress(e.to_string()))?;
    let mut dec = xz2::read::XzDecoder::new_stream(data, stream);
    let out = read_capped(&mut dec, max_output)?;
    if dec.total_in() != data.len() as u64 {
        return Err(Error::Compress(
            "trailing bytes after xz stream (§10.1 single-stream)".into(),
        ));
    }
    Ok(out)
}

/// Compress `data` with zstd at the given level.
/// For small files, uses maximum compression (level 22) by default.
///
/// The encoder window is capped at [`ZSTD_WINDOW_LOG_MAX`] so every stream
/// this stack produces stays decodable under the matching receiver-side
/// window clamp. (The zstd crate's `encode_all` is a streaming encoder with
/// no pledged src size, so high levels otherwise declare the full table
/// window — level 22 → windowLog 27 — even for tiny inputs, which its own
/// clamped decoder would then reject.)
#[cfg(not(target_arch = "wasm32"))]
pub fn compress(data: &[u8], level: i32) -> Result<Vec<u8>> {
    use std::io::Write;
    let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), level)
        .map_err(|e| Error::Compress(e.to_string()))?;
    encoder
        .window_log(ZSTD_WINDOW_LOG_MAX)
        .map_err(|e| Error::Compress(e.to_string()))?;
    encoder
        .write_all(data)
        .map_err(|e| Error::Compress(e.to_string()))?;
    encoder
        .finish()
        .map_err(|e| Error::Compress(e.to_string()))
}

/// Decompress zstd-encoded `data`. (Kept for backward compatibility.)
///
/// Single-frame + no-trailing + window clamp are enforced via
/// [`zstd_decode_bounded`].
#[cfg(not(target_arch = "wasm32"))]
pub fn decompress(data: &[u8]) -> Result<Vec<u8>> {
    zstd_decode_bounded(data, usize::MAX)
}

/// Compress `data` with the algorithm identified by a [`COMPRESSION_*`] tag.
///
/// `COMPRESSION_NONE` returns the bytes unchanged. Unknown tags are treated as
/// no compression so a receiver never fails purely on an unrecognized algo.
#[cfg(not(target_arch = "wasm32"))]
pub fn compress_with(data: &[u8], compression: u8) -> Result<Vec<u8>> {
    match compression {
        COMPRESSION_ZSTD => compress(data, DEFAULT_LEVEL),
        COMPRESSION_XZ => xz_compress(data),
        _ => Ok(data.to_vec()),
    }
}

/// Decompress `data` using the algorithm identified by a [`COMPRESSION_*`] tag.
///
/// `COMPRESSION_NONE` (and any unrecognized tag) returns the bytes unchanged,
/// which keeps a descriptor/algorithm mismatch non-fatal.
#[cfg(not(target_arch = "wasm32"))]
pub fn decompress_with(data: &[u8], compression: u8) -> Result<Vec<u8>> {
    match compression {
        COMPRESSION_ZSTD => decompress(data),
        COMPRESSION_XZ => xz_decode_bounded(data, usize::MAX, MAX_XZ_DICT_BYTES),
        _ => Ok(data.to_vec()),
    }
}

/// Like [`decompress_with`] but bounds the **output** size to `max_output` bytes.
///
/// The receiver decompresses data recovered from an untrusted optical stream. A
/// tiny zstd/xz payload can legitimately expand 1000×+ (a "decompression bomb"),
/// so without an output cap a crafted transfer would OOM the Android receiver at
/// assemble time. The caller passes the descriptor's expected original size as
/// the cap; if the stream produces more than that, it's rejected. Unknown
/// algorithm tags with non-empty payload return an error (see
/// [`is_known_compression_tag`]).
#[cfg(not(target_arch = "wasm32"))]
pub fn decompress_with_limit(data: &[u8], compression: u8, max_output: usize) -> Result<Vec<u8>> {
    match compression {
        COMPRESSION_ZSTD => zstd_decode_bounded(data, max_output),
        COMPRESSION_XZ => xz_decode_bounded(data, max_output, MAX_XZ_DICT_BYTES),
        _ => {
            if !is_known_compression_tag(compression) && !data.is_empty() {
                return Err(Error::Compress(format!(
                    "unknown compression algorithm tag {compression}"
                )));
            }
            if data.len() > max_output {
                return Err(Error::Compress("payload exceeds size limit".into()));
            }
            Ok(data.to_vec())
        }
    }
}

/// AF2 per-chunk bounded decompression (§10.1): single frame/stream, no
/// trailing bytes, declared XZ dictionary ≤ `min(chunk_raw_size, 32 MiB)`,
/// output capped at `max_output` (the chunk's canonical raw length). This is
/// the entry `af2::chunk::decode_chunk` uses; the generic
/// [`decompress_with_limit`] keeps the looser absolute 32 MiB dict cap for
/// legacy callers that have no chunking context.
#[cfg(not(target_arch = "wasm32"))]
pub fn decompress_chunk(
    data: &[u8],
    compression: u8,
    max_output: usize,
    chunk_raw_size: u32,
) -> Result<Vec<u8>> {
    match compression {
        COMPRESSION_ZSTD => zstd_decode_bounded(data, max_output),
        COMPRESSION_XZ => xz_decode_bounded(
            data,
            max_output,
            u64::from(chunk_raw_size).min(MAX_XZ_DICT_BYTES),
        ),
        _ => decompress_with_limit(data, compression, max_output),
    }
}

/// Read a decoder fully but refuse to produce more than `max_output` bytes.
fn read_capped<R: std::io::Read>(r: R, max_output: usize) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    // Read one byte past the cap so an over-limit stream can be detected.
    let read_limit = u64::try_from(max_output)
        .unwrap_or(u64::MAX - 1)
        .saturating_add(1);
    r.take(read_limit)
        .read_to_end(&mut out)
        .map_err(|e| Error::Compress(e.to_string()))?;
    if out.len() > max_output {
        return Err(Error::Compress(
            "decompressed output exceeds expected size".into(),
        ));
    }
    Ok(out)
}

/// Streaming result of [`decompress_stream_to_file`].
#[cfg(not(target_arch = "wasm32"))]
pub struct DecompressStreamOutcome {
    /// Number of decompressed bytes written to the output file.
    pub output_size: u64,
    /// Incremental CRC32 over the decompressed bytes.
    pub crc32: u32,
    /// Incremental SHA-256 over the decompressed bytes.
    pub sha256: [u8; 32],
}

/// Stream a compressed stream from `input_path` to `output_path`, decompressing
/// as it goes, while computing CRC32 + SHA-256 incrementally. Neither the
/// compressed input nor the decompressed output is ever held wholly in memory,
/// so a very large file can be recovered within bounded RAM.
///
/// `max_output` is a hard cap on the decompressed size (defends against a
/// decompression bomb): the stream is rejected as soon as it would exceed it.
/// On any failure (I/O, cap breach, decoder error) the partial output file is
/// removed so a later retry never reads a truncated file as success.
#[cfg(not(target_arch = "wasm32"))]
pub fn decompress_stream_to_file(
    input_path: &str,
    output_path: &str,
    compression: u8,
    max_output: u64,
) -> Result<DecompressStreamOutcome> {
    use sha2::Digest;
    use std::io::{BufRead, BufWriter, Read, Write};

    let in_file =
        std::fs::File::open(input_path).map_err(|e| Error::Compress(format!("open input: {e}")))?;
    let file_len = in_file
        .metadata()
        .map_err(|e| Error::Compress(format!("input metadata: {e}")))?
        .len();
    let mut reader = std::io::BufReader::with_capacity(128 * 1024, in_file);
    let out_file = std::fs::File::create(output_path)
        .map_err(|e| Error::Compress(format!("create output: {e}")))?;
    let mut writer = BufWriter::with_capacity(1 << 20, out_file);

    // Channel a capped decode into a closure that hashes + writes chunks.
    let mut crc = crc32fast::Hasher::new();
    let mut sha = sha2::Sha256::new();
    let mut written: u64 = 0;
    let mut over = false;

    let mut decode = |reader: &mut dyn Read| -> Result<()> {
        let mut reader = reader.take(max_output.saturating_add(1));
        let mut buf = [0u8; 256 * 1024];
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| Error::Compress(format!("read: {e}")))?;
            if n == 0 {
                break;
            }
            written = written.saturating_add(n as u64);
            if written > max_output {
                over = true;
                break;
            }
            crc.update(&buf[..n]);
            sha.update(&buf[..n]);
            writer
                .write_all(&buf[..n])
                .map_err(|e| Error::Compress(format!("write: {e}")))?;
        }
        Ok(())
    };

    // Build the decoder and run the decode loop, threading ALL errors through
    // `result` (never `?` out of this match) so the `if let Err(e) = result`
    // cleanup below removes the partial output file on ANY failure — including
    // decoder construction (a corrupt/truncated compressed stream can make
    // `Decoder::new` / `Stream::new_stream_decoder` fail, leaving a freshly-
    // created empty output file that must not linger).
    let result: Result<()> = match compression {
        // Window-clamped single-frame streaming decoder (audit L1 + §10.1):
        // same ZSTD_WINDOW_LOG_MAX bound as the in-memory path. The ~128 KiB
        // BufReader capacity mirrors libzstd's ZSTD_DStreamInSize (what
        // Decoder::new would have used).
        COMPRESSION_ZSTD => zstd_decoder(&mut reader).and_then(|mut dec| {
            decode(&mut dec).and_then(|_| {
                // §10.1 no-trailing: nothing may remain after the frame (the
                // decoder's inner BufReader still serves any look-ahead).
                let mut byte = [0u8; 1];
                match std::io::Read::read(dec.get_mut(), &mut byte) {
                    Ok(0) => Ok(()),
                    Ok(_) => Err(Error::Compress(
                        "trailing bytes after zstd frame (§10.1 single-frame)".into(),
                    )),
                    Err(e) => Err(Error::Compress(format!("trailing check: {e}"))),
                }
            })
        }),
        COMPRESSION_XZ => {
            // §10.1 declared-dictionary bound: peek the block header without
            // consuming (fill_buf only fills, does not advance).
            let dict = reader
                .fill_buf()
                .map_err(|e| Error::Compress(format!("peek: {e}")))
                .and_then(|buf| xz_declared_dict_size(buf).map_err(Error::Compress));
            dict.and_then(|dict| {
                if dict > MAX_XZ_DICT_BYTES {
                    return Err(Error::Compress(format!(
                        "xz declared dictionary {dict} exceeds cap {MAX_XZ_DICT_BYTES}"
                    )));
                }
                xz2::stream::Stream::new_stream_decoder(XZ_DECODER_MEMORY_LIMIT, 0)
                    .map_err(|e| Error::Compress(e.to_string()))
                    .and_then(|stream| {
                        let mut dec = xz2::read::XzDecoder::new_stream(&mut reader, stream);
                        decode(&mut dec).map(|_| dec.total_in()).and_then(|total_in| {
                            if total_in != file_len {
                                Err(Error::Compress(
                                    "trailing bytes after xz stream (§10.1 single-stream)".into(),
                                ))
                            } else {
                                Ok(())
                            }
                        })
                    })
            })
        }
        _ => {
            // COMPRESSION_NONE (or unknown tag with empty input): the "stream"
            // is already the original bytes — copy as-is.
            if is_known_compression_tag(compression) || file_len == 0 {
                decode(&mut reader)
            } else {
                // An unknown tag with non-empty input is an error, mirroring
                // `decompress_with_limit`.
                Err(Error::Compress(format!(
                    "unknown compression algorithm tag {compression}"
                )))
            }
        }
    };

    if let Err(e) = result {
        drop(writer);
        let _ = std::fs::remove_file(output_path);
        return Err(e);
    }
    if over {
        drop(writer);
        let _ = std::fs::remove_file(output_path);
        return Err(Error::Compress(
            "decompressed output exceeds expected size".into(),
        ));
    }
    // Flush is the last fallible step. The documented contract is "any failure
    // removes the partial output" — flush must not be a `?` that bypasses the
    // remove (a failed flush can leave a partial/truncated file on disk). Handle
    // it inline and remove on failure, mirroring the decode/over-limit branches.
    if let Err(e) = writer.flush() {
        drop(writer);
        let _ = std::fs::remove_file(output_path);
        return Err(Error::Compress(format!("flush: {e}")));
    }
    let digest = sha.finalize();
    Ok(DecompressStreamOutcome {
        output_size: written,
        crc32: crc.finalize(),
        sha256: digest.into(),
    })
}

/// wasm32 zstd decode via `ruzstd` (pure Rust — the zstd C crate does not
/// build for `wasm32-unknown-unknown`). §10.1 bounds: declared window
/// pre-checked against 2^23 by [`zstd_window_log_ok`], single frame, no
/// trailing bytes (ruzstd EOFs after the first frame; the source reader's
/// remaining length is the trailing check), output capped.
///
/// Also compiled under `cfg(test)` so native `cargo test` exercises the
/// web receiver's actual decode stack against native-produced frames —
/// otherwise half of the cross-end codec matrix has no CI coverage.
#[cfg(any(target_arch = "wasm32", test))]
fn wasm_zstd_decode_bounded(data: &[u8], max_output: usize) -> Result<Vec<u8>> {
    if !zstd_window_log_ok(data) {
        return Err(Error::Compress(
            "zstd frame malformed or window exceeds 2^23 (§10.1)".into(),
        ));
    }
    let mut source = data;
    let mut dec = ruzstd::StreamingDecoder::new(&mut source)
        .map_err(|e| Error::Compress(e.to_string()))?;
    let out = read_capped(&mut dec, max_output)?;
    if !source.is_empty() {
        return Err(Error::Compress(
            "trailing bytes after zstd frame (§10.1 single-frame)".into(),
        ));
    }
    Ok(out)
}

/// Sink that aborts the lzma-rs decoder the moment its output would exceed
/// the expected cap: lzma-rs writes decoded bytes through incrementally, so a
/// hostile "larger than declared" stream cannot transiently allocate its full
/// expansion before rejection (mirrors `read_capped` on the zstd paths).
#[cfg(any(target_arch = "wasm32", test))]
struct CappedWriter {
    out: Vec<u8>,
    cap: usize,
}

#[cfg(any(target_arch = "wasm32", test))]
impl std::io::Write for CappedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.out.len().saturating_add(buf.len()) > self.cap {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "decompressed output exceeds expected size",
            ));
        }
        self.out.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// wasm32 XZ decode via `lzma-rs` (pure Rust). §10.1 bounds: declared
/// dictionary parsed and capped before the decoder runs, single stream, no
/// trailing bytes (lzma-rs stops at the footer; the remaining slice length
/// is the trailing check), output capped by [`CappedWriter`] while decoding.
///
/// Also compiled under `cfg(test)` — see [`zstd_decode_bounded`].
#[cfg(any(target_arch = "wasm32", test))]
fn wasm_xz_decode_bounded(data: &[u8], max_output: usize, dict_cap: u64) -> Result<Vec<u8>> {
    let dict = xz_declared_dict_size(data).map_err(Error::Compress)?;
    if dict > dict_cap {
        return Err(Error::Compress(format!(
            "xz declared dictionary {dict} exceeds cap {dict_cap}"
        )));
    }
    let mut input = data;
    let mut sink = CappedWriter {
        out: Vec::new(),
        cap: max_output,
    };
    lzma_rs::xz_decompress(&mut input, &mut sink).map_err(|e| Error::Compress(e.to_string()))?;
    let out = sink.out;
    if out.len() > max_output {
        return Err(Error::Compress(
            "decompressed output exceeds expected size".into(),
        ));
    }
    if !input.is_empty() {
        return Err(Error::Compress(
            "trailing bytes after xz stream (§10.1 single-stream)".into(),
        ));
    }
    Ok(out)
}

/// wasm32 bounded decompress (§10.1-structured): the browser now decodes all
/// three wire codecs inside the Rust core. See [`decompress_chunk`] for the
/// AF2 chunk entry point.
#[cfg(target_arch = "wasm32")]
pub fn decompress_with_limit(data: &[u8], compression: u8, max_output: usize) -> Result<Vec<u8>> {
    match compression {
        COMPRESSION_ZSTD => wasm_zstd_decode_bounded(data, max_output),
        COMPRESSION_XZ => wasm_xz_decode_bounded(data, max_output, MAX_XZ_DICT_BYTES),
        _ => {
            if !is_known_compression_tag(compression) && !data.is_empty() {
                return Err(Error::Compress(format!(
                    "unknown compression algorithm tag {compression}"
                )));
            }
            if data.len() > max_output {
                return Err(Error::Compress("payload exceeds size limit".into()));
            }
            Ok(data.to_vec())
        }
    }
}

/// AF2 per-chunk bounded decompression on wasm32 — same contract as the
/// native [`decompress_chunk`].
#[cfg(target_arch = "wasm32")]
pub fn decompress_chunk(
    data: &[u8],
    compression: u8,
    max_output: usize,
    chunk_raw_size: u32,
) -> Result<Vec<u8>> {
    match compression {
        COMPRESSION_XZ => wasm_xz_decode_bounded(
            data,
            max_output,
            u64::from(chunk_raw_size).min(MAX_XZ_DICT_BYTES),
        ),
        _ => decompress_with_limit(data, compression, max_output),
    }
}

/// wasm32 unbounded decompress: routes through the bounded path with a hard
/// 256 MiB ceiling so no caller can turn an unbounded call into a bomb.
#[cfg(target_arch = "wasm32")]
pub fn decompress_with(data: &[u8], compression: u8) -> Result<Vec<u8>> {
    decompress_with_limit(data, compression, 256 * 1024 * 1024)
}

/// wasm32 zstd compress via `zrip` (pure Rust).
/// Clamps windowLog to `ZSTD_WINDOW_LOG_MAX` (23) so the produced frame is accepted
/// by the receiver's window clamp.
#[cfg(target_arch = "wasm32")]
pub fn compress(data: &[u8], level: i32) -> Result<Vec<u8>> {
    let opts = zrip::Options::default().window_log(ZSTD_WINDOW_LOG_MAX);
    let z_level = level.clamp(1, 4);
    zrip::compress_opts(data, z_level, &opts).map_err(|e| Error::Compress(e.to_string()))
}

/// wasm32 XZ/LZMA2 compress via `lzma-rust2` (pure Rust).
/// Clamps declared dictionary to `min(chunk_raw_size/payload_len, 32 MiB)` and uses CRC64 check.
#[cfg(target_arch = "wasm32")]
fn xz_compress(data: &[u8]) -> Result<Vec<u8>> {
    compress_xz_preset(data, 6)
}

/// wasm32 preset-parameterized XZ encode (lzma-rust2) — see the native
/// [`compress_xz_preset`] doc for the sender-policy usage.
#[cfg(target_arch = "wasm32")]
pub fn compress_xz_preset(data: &[u8], preset: u32) -> Result<Vec<u8>> {
    use std::io::Write;
    let dict = lzma2_dict_at_most((data.len() as u64).clamp(MIN_XZ_DICT_BYTES, MAX_XZ_DICT_BYTES));
    let mut lzma_opts = lzma_rust2::LzmaOptions::with_preset(preset.min(9));
    lzma_opts.dict_size = dict as u32;
    let mut xz_opts = lzma_rust2::XzOptions {
        lzma_options: lzma_opts,
        ..Default::default()
    };
    xz_opts.set_check_sum_type(lzma_rust2::CheckType::Crc64);
    let mut writer = lzma_rust2::XzWriter::new(Vec::new(), xz_opts)
        .map_err(|e| Error::Compress(e.to_string()))?;
    writer
        .write_all(data)
        .map_err(|e| Error::Compress(e.to_string()))?;
    writer.finish().map_err(|e| Error::Compress(e.to_string()))
}

/// The per-target standard high-ratio XZ preset (wasm32: 6 via lzma-rust2) —
/// the "escalation" codec of the AF2 balanced sender policy.
#[cfg(target_arch = "wasm32")]
pub fn compress_xz_standard(data: &[u8]) -> Result<Vec<u8>> {
    xz_compress(data)
}

/// wasm32 compress_with dispatch: RAW, Zstd (zrip), XZ (lzma-rust2).
#[cfg(target_arch = "wasm32")]
pub fn compress_with(data: &[u8], compression: u8) -> Result<Vec<u8>> {
    match compression {
        COMPRESSION_ZSTD => compress(data, 1),
        COMPRESSION_XZ => xz_compress(data),
        _ => Ok(data.to_vec()),
    }
}

/// Compress `data` with XZ/LZMA2 at a high-ratio preset (level 6 + EXTREME).
///
/// The declared dictionary is clamped to the largest legal size ≤ the input
/// length (and always ≤ 32 MiB): §10.1 receivers reject dictionaries above
/// `min(chunk_raw_size, 32 MiB)`, and a window larger than the payload is
/// useless anyway. Memory usage stays modest at level 6 (~95 MB decoder
/// footprint), which keeps the Android JVM heap (typically 256 MB) safe even
/// on low-end devices.
#[cfg(not(target_arch = "wasm32"))]
fn xz_compress(data: &[u8]) -> Result<Vec<u8>> {
    compress_xz_preset(data, XZ_PRESET)
}

/// Compress `data` with XZ/LZMA2 at an arbitrary preset (0..=9, optionally
/// `| LZMA_PRESET_EXTREME` on native). Dictionary is clamped exactly like the
/// standard path. Sender-side policy (the AF2 balanced pre-encode) uses this
/// to trade ratio against encode time (preset 2 vs the standard preset).
#[cfg(not(target_arch = "wasm32"))]
pub fn compress_xz_preset(data: &[u8], preset: u32) -> Result<Vec<u8>> {
    use std::io::Write;
    let dict = lzma2_dict_at_most((data.len() as u64).clamp(MIN_XZ_DICT_BYTES, MAX_XZ_DICT_BYTES));
    let mut opts = xz2::stream::LzmaOptions::new_preset(preset)
        .map_err(|e| Error::Compress(e.to_string()))?;
    opts.dict_size(dict);
    let mut filters = xz2::stream::Filters::new();
    filters.lzma2(&opts);
    let stream = xz2::stream::Stream::new_stream_encoder(&filters, xz2::stream::Check::Crc64)
        .map_err(|e| Error::Compress(e.to_string()))?;
    let mut encoder = xz2::write::XzEncoder::new_stream(Vec::new(), stream);
    encoder
        .write_all(data)
        .map_err(|e| Error::Compress(e.to_string()))?;
    encoder.finish().map_err(|e| Error::Compress(e.to_string()))
}

/// The per-target standard high-ratio XZ preset (native: 6|EXTREME, wasm32:
/// 6) — the "escalation" codec of the AF2 balanced sender policy.
#[cfg(not(target_arch = "wasm32"))]
pub fn compress_xz_standard(data: &[u8]) -> Result<Vec<u8>> {
    xz_compress(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zstd_round_trip() {
        let data: Vec<u8> = (0..40_000).map(|i| (i & 0xff) as u8).collect();
        let c = compress(&data, DEFAULT_LEVEL).unwrap();
        let d = decompress(&c).unwrap();
        assert_eq!(d, data);
    }

    #[test]
    fn zstd_compressed_data_shrinks_for_repetitive_input() {
        let data = vec![0xABu8; 10_000];
        let c = compress(&data, DEFAULT_LEVEL).unwrap();
        assert!(c.len() < data.len());
    }

    #[test]
    fn xz_round_trip() {
        let data: Vec<u8> = (0..10_000).map(|i| (i & 0xff) as u8).collect();
        let compressed = xz_compress(&data).unwrap();
        let decompressed = decompress_with(&compressed, COMPRESSION_XZ).unwrap();
        assert_eq!(decompressed, data);
    }

    #[test]
    fn xz_compresses_repetitive_input_aggressively() {
        let data = vec![0xABu8; 10_000];
        let compressed = xz_compress(&data).unwrap();
        // Highly repetitive input should compress well over 90% (the .xz stream
        // container itself costs ~60 bytes of header/footer/index).
        assert!(compressed.len() < data.len() / 10);
    }

    #[test]
    fn compress_with_and_decompress_with_dispatch() {
        let data: Vec<u8> = (0..8_000).map(|i| (i & 0xff) as u8).collect();

        // Zstd path.
        let z = compress_with(&data, COMPRESSION_ZSTD).unwrap();
        assert_eq!(decompress_with(&z, COMPRESSION_ZSTD).unwrap(), data);

        // XZ path.
        let x = compress_with(&data, COMPRESSION_XZ).unwrap();
        assert_eq!(decompress_with(&x, COMPRESSION_XZ).unwrap(), data);

        // None path is identity.
        assert_eq!(compress_with(&data, COMPRESSION_NONE).unwrap(), data);
        assert_eq!(decompress_with(&data, COMPRESSION_NONE).unwrap(), data);
    }

    #[test]
    fn unknown_compression_tag_is_identity() {
        let data = vec![1u8, 2, 3, 4];
        assert_eq!(compress_with(&data, 99).unwrap(), data);
        assert_eq!(decompress_with(&data, 99).unwrap(), data);
    }

    #[test]
    fn unknown_compression_tag_rejected_on_limited_decompress() {
        let data = vec![1u8, 2, 3, 4];
        assert!(decompress_with_limit(&data, 99, 1024).is_err());
        assert_eq!(
            decompress_with_limit(&[], 99, 1024).unwrap(),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn decompress_with_limit_rejects_bomb() {
        // Highly compressible input expands far beyond a tiny cap.
        let data = vec![0u8; 1_000_000];
        let z = compress(&data, DEFAULT_LEVEL).unwrap();
        assert!(z.len() < 10_000, "should compress tiny");
        // Cap below the true output → rejected (bomb defense).
        assert!(decompress_with_limit(&z, COMPRESSION_ZSTD, 1000).is_err());
        // Cap at the true output → ok.
        assert_eq!(
            decompress_with_limit(&z, COMPRESSION_ZSTD, data.len()).unwrap(),
            data
        );

        // XZ path behaves the same.
        let x = xz_compress(&data).unwrap();
        assert!(decompress_with_limit(&x, COMPRESSION_XZ, 1000).is_err());
        assert_eq!(
            decompress_with_limit(&x, COMPRESSION_XZ, data.len()).unwrap(),
            data
        );
    }

    /// Hand-assembled, otherwise-valid zstd frame that declares a
    /// windowLog of 27 (a 128 MiB back-reference window — the libzstd default
    /// `ZSTD_WINDOWLOG_LIMIT_DEFAULT`, so an *unclamped* streaming decoder
    /// accepts it and allocates the full window before producing any output).
    /// Body is a single raw (uncompressed) block, so the stream itself is
    /// perfectly decodable; only the declared window is oversized.
    fn oversized_window_frame() -> Vec<u8> {
        let mut f = Vec::new();
        f.extend_from_slice(&[0x28, 0xB5, 0x2F, 0xFD]); // zstd magic (LE)
        f.push(0x00); // Frame_Header_Descriptor: no FCS, no checksum, no dict
        f.push(0x88); // Window_Descriptor: exponent 17, mantissa 0 → windowLog 27
        // Block header (3B LE): last=1, type=0 (Raw), size=4.
        f.extend_from_slice(&[0x21, 0x00, 0x00]);
        f.extend_from_slice(b"ABCD");
        f
    }

    /// Audit L1: the receiver-side zstd decoder must clamp
    /// `ZSTD_d_windowLogMax` so a hostile CRC-valid frame header cannot force
    /// a 128 MiB window allocation. The frame built above is wire-valid (an
    /// unclamped decoder returns its payload), yet the clamped
    /// `decompress_with_limit` must reject it.
    #[test]
    fn decompress_with_limit_rejects_oversized_zstd_window() {
        let frame = oversized_window_frame();
        // Sanity: the frame is a legitimate zstd stream that a default
        // (unclamped) decoder happily decodes.
        assert_eq!(
            zstd::decode_all(&frame[..]).unwrap(),
            b"ABCD".to_vec(),
            "test frame must be a valid zstd stream"
        );
        // The clamped receiver path refuses it (frameParameter_unsupported).
        assert!(
            decompress_with_limit(&frame, COMPRESSION_ZSTD, 1024).is_err(),
            "oversized zstd window must be rejected"
        );
    }

    /// Same clamp on the streaming-to-disk path used by Android/Windows:
    /// an oversized-window frame must fail (and the partial output file must
    /// be cleaned up).
    #[test]
    fn decompress_stream_to_file_rejects_oversized_zstd_window() {
        let frame = oversized_window_frame();
        let dir = std::env::temp_dir();
        let input = dir.join(format!("airferry_win_clamp_in_{}.zst", std::process::id()));
        let output = dir.join(format!("airferry_win_clamp_out_{}.bin", std::process::id()));
        std::fs::write(&input, &frame).unwrap();
        let result = decompress_stream_to_file(
            input.to_str().unwrap(),
            output.to_str().unwrap(),
            COMPRESSION_ZSTD,
            1024,
        );
        let _ = std::fs::remove_file(&input);
        assert!(result.is_err(), "oversized zstd window must be rejected");
        assert!(
            !output.exists(),
            "failed decode must not leave a partial output file"
        );
    }

    /// The clamp must not break legitimate streams: every level/size this
    /// stack produces must still round-trip through the *clamped* decoder.
    /// Level 1 is what the production TS sender uses (≤ 256 MiB inputs,
    /// table windowLog 19); level 22 is the Rust-side default — [`compress`]
    /// caps its encoder window at 23, so its output declares ≤ 23 and is
    /// accepted by construction.
    #[test]
    fn clamped_zstd_decoder_accepts_legitimate_streams() {
        for (level, len) in [(1, 1 << 20), (3, 300_000), (DEFAULT_LEVEL, 40_000)] {
            let data: Vec<u8> = (0..len).map(|i| ((i * 31) & 0xff) as u8).collect();
            let z = compress(&data, level).unwrap();
            assert_eq!(
                decompress_with_limit(&z, COMPRESSION_ZSTD, data.len()).unwrap(),
                data,
                "level {level} / {len} bytes must survive the window clamp"
            );
            // And the legacy `decompress` path (same clamp).
            assert_eq!(decompress(&z).unwrap(), data);
        }
    }

    // --- §10.1 structural enforcement: single frame/stream, no trailing ---

    #[test]
    fn lzma2_dict_prop_decoding_known_values() {
        // Reference points from the LZMA2 property table (xz-file-format §5.3.2).
        assert_eq!(lzma2_dict_from_prop(0), 4096); // 2^12
        assert_eq!(lzma2_dict_from_prop(1), 6144); // 1.5 · 2^12
        assert_eq!(lzma2_dict_from_prop(22), 8 << 20); // preset-6 dict
        assert_eq!(lzma2_dict_from_prop(39), 3 << 30); // 3 GiB
        assert_eq!(lzma2_dict_from_prop(40), 0xFFFF_FFFF); // 4 GiB−1 sentinel
        // Encoder clamp helper picks the largest legal size ≤ cap.
        assert_eq!(lzma2_dict_at_most(300_000), 262_144);
        assert_eq!(lzma2_dict_at_most(1 << 20), 1 << 20);
        assert_eq!(lzma2_dict_at_most(1), 4096); // never below the format floor
    }

    #[test]
    fn xz_encoder_dict_never_expects_input_bounds() {
        // xz_compress must declare a dict ≤ its input length so the §10.1
        // receiver bound (≤ chunk size) always holds for our own streams.
        for len in [70_000usize, 300_000, 5_000_000] {
            let data = vec![0x77u8; len];
            let x = xz_compress(&data).unwrap();
            let dict = xz_declared_dict_size(&x).unwrap();
            assert!(dict <= len as u64, "dict {dict} must be ≤ input {len}");
            // And it decodes under the matching chunk cap.
            let out = decompress_chunk(&x, COMPRESSION_XZ, len, len as u32).unwrap();
            assert_eq!(out.len(), len);
        }
    }

    #[test]
    fn decompress_rejects_concatenated_zstd_frames() {
        let data: Vec<u8> = (0..20_000).map(|i| (i & 0xff) as u8).collect();
        let z = compress(&data, DEFAULT_LEVEL).unwrap();
        let mut doubled = z.clone();
        doubled.extend_from_slice(&z);
        assert!(
            decompress_with_limit(&doubled, COMPRESSION_ZSTD, 2 * data.len()).is_err(),
            "concatenated frames violate §10.1 single-frame"
        );
    }

    #[test]
    fn decompress_rejects_trailing_bytes_after_zstd_frame() {
        let data: Vec<u8> = (0..20_000).map(|i| (i & 0xff) as u8).collect();
        let mut z = compress(&data, DEFAULT_LEVEL).unwrap();
        z.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        assert!(
            decompress_with_limit(&z, COMPRESSION_ZSTD, data.len()).is_err(),
            "trailing garbage violates §10.1 single-frame"
        );
    }

    #[test]
    fn decompress_rejects_concatenated_xz_streams_and_trailing() {
        let data: Vec<u8> = (0..20_000).map(|i| (i & 0xff) as u8).collect();
        let x = xz_compress(&data).unwrap();
        let mut doubled = x.clone();
        doubled.extend_from_slice(&x);
        assert!(
            decompress_with_limit(&doubled, COMPRESSION_XZ, 2 * data.len()).is_err(),
            "concatenated streams violate §10.1 single-stream"
        );
        let mut trailed = x.clone();
        trailed.extend_from_slice(&[0x00, 0x01, 0x02]);
        assert!(
            decompress_with_limit(&trailed, COMPRESSION_XZ, data.len()).is_err(),
            "trailing bytes violate §10.1 single-stream"
        );
    }

    #[test]
    fn zstd_window_log_precheck_matches_clamp() {
        // The shared header pre-check (used by the wasm decoder) agrees with
        // the native clamp on both a hostile oversized window and a normal one.
        let hostile = oversized_window_frame();
        assert!(!zstd_window_log_ok(&hostile));
        let ok: Vec<u8> = (0..20_000).map(|i| (i & 0xff) as u8).collect();
        let z = compress(&ok, DEFAULT_LEVEL).unwrap();
        assert!(zstd_window_log_ok(&z));
    }

    /// Verify that the pure-Rust wasm32 compression codecs (zrip and lzma-rust2)
    /// produce valid streams that decode cleanly with §10.1 bounds under both
    /// native and wasm decoders.
    #[test]
    fn zrip_and_lzma_rust2_roundtrip_with_decoders() {
        let data: Vec<u8> = b"The quick brown fox jumps over the lazy dog. 1234567890\n"
            .repeat(1000);

        // 1. zrip compression -> decodes with native/bounded zstd decoder
        let opts = zrip::Options::default().window_log(ZSTD_WINDOW_LOG_MAX);
        let zrip_out = zrip::compress_opts(&data, 1, &opts).unwrap();
        assert!(zrip_out.len() < data.len());
        assert!(zstd_window_log_ok(&zrip_out));
        let zrip_dec = decompress_with(&zrip_out, COMPRESSION_ZSTD).unwrap();
        assert_eq!(zrip_dec, data);

        // 2. lzma-rust2 compression -> decodes with native/bounded xz decoder
        use std::io::Write;
        let dict = lzma2_dict_at_most((data.len() as u64).clamp(MIN_XZ_DICT_BYTES, MAX_XZ_DICT_BYTES));
        let mut lzma_opts = lzma_rust2::LzmaOptions::with_preset(6);
        lzma_opts.dict_size = dict;
        let mut xz_opts = lzma_rust2::XzOptions {
            lzma_options: lzma_opts,
            ..Default::default()
        };
        xz_opts.set_check_sum_type(lzma_rust2::CheckType::Crc64);
        let mut writer = lzma_rust2::XzWriter::new(Vec::new(), xz_opts).unwrap();
        writer.write_all(&data).unwrap();
        let xz_out = writer.finish().unwrap();
        assert!(xz_out.len() < data.len());
        let xz_dec = decompress_with(&xz_out, COMPRESSION_XZ).unwrap();
        assert_eq!(xz_dec, data);
    }

    /// The REVERSE cross-end direction: frames produced by the NATIVE C
    /// encoders (what Android/Windows senders emit) must decode through the
    /// pure-Rust wasm decoder stack (what the web receiver runs) under the
    /// same §10.1 bounds. Together with
    /// [`zrip_and_lzma_rust2_roundtrip_with_decoders`] this closes the whole
    /// cross-end codec matrix inside plain `cargo test`.
    #[test]
    fn native_frames_decode_through_wasm_decoder_stack() {
        let text: Vec<u8> =
            b"The quick brown fox jumps over the lazy dog. 1234567890\n".repeat(1000);
        let zeros = vec![0u8; 300_000];

        // 1. native zstd (fast L1 and max level) → wasm ruzstd decode.
        for level in [1, 22] {
            let z = compress(&text, level).unwrap();
            assert!(
                zstd_window_log_ok(&z),
                "native L{level} frame must pass the window pre-check"
            );
            assert_eq!(wasm_zstd_decode_bounded(&z, text.len()).unwrap(), text);
        }
        assert_eq!(
            wasm_zstd_decode_bounded(&compress(&zeros, 1).unwrap(), zeros.len()).unwrap(),
            zeros
        );
        // Over-cap rejection fires AT the cap (read_capped stops at max+1).
        let z = compress(&text, 1).unwrap();
        assert!(wasm_zstd_decode_bounded(&z, text.len() - 1).is_err());
        // Trailing garbage after the frame is rejected (single-frame rule).
        let mut trailed = compress(&text, 1).unwrap();
        trailed.extend_from_slice(&[0xDE, 0xAD]);
        assert!(wasm_zstd_decode_bounded(&trailed, text.len()).is_err());

        // 2. native xz (fast p2 + standard preset) → wasm lzma-rs decode.
        let x2 = compress_xz_preset(&text, 2).unwrap();
        let x6 = compress_xz_standard(&text).unwrap();
        for x in [&x2, &x6] {
            assert_eq!(
                wasm_xz_decode_bounded(x, text.len(), MAX_XZ_DICT_BYTES).unwrap(),
                text
            );
        }
        let x0 = compress_xz_preset(&zeros, 2).unwrap();
        assert!(xz_declared_dict_size(&x0).unwrap() <= MAX_XZ_DICT_BYTES);
        assert_eq!(
            wasm_xz_decode_bounded(&x0, zeros.len(), MAX_XZ_DICT_BYTES).unwrap(),
            zeros
        );
        // Over-cap rejection aborts the decoder via the capped writer.
        assert!(wasm_xz_decode_bounded(&x2, text.len() - 1, MAX_XZ_DICT_BYTES).is_err());

        // 3. web↔web: the pure-Rust wasm encoders through the wasm decoder stack.
        let opts = zrip::Options::default().window_log(ZSTD_WINDOW_LOG_MAX);
        let zrip_out = zrip::compress_opts(&text, 2, &opts).unwrap();
        assert_eq!(wasm_zstd_decode_bounded(&zrip_out, text.len()).unwrap(), text);
    }
}
