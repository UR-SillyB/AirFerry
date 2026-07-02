//! WebAssembly bindings for the browser extension (sender side).
//!
//! Exposes a thin `SenderSessionWasm` that the TypeScript/React layer drives
//! from its render loop. Returns frames as `Uint8Array` (via `Vec<u8>` → JS).

#![cfg(feature = "wasm")]

use crate::sender::{SenderConfig, SenderSession};
use qr_protocol::SessionId;
use raptorq_core::Config;
use wasm_bindgen::prelude::*;

/// Install a panic hook that routes Rust panic messages to the JS console.
/// Without this, a panic surfaces only as a bare `RuntimeError: unreachable`.
/// Call once at module init.
#[wasm_bindgen(start)]
pub fn _start() {
    static SET: std::sync::Once = std::sync::Once::new();
    SET.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            web_sys::console::error_1(&format!("AirFerry WASM panic: {info}").into());
        }));
    });
}

/// WASM-facing sender session.
#[wasm_bindgen]
pub struct SenderSessionWasm {
    inner: SenderSession,
}

#[wasm_bindgen]
impl SenderSessionWasm {
    /// Create from payload bytes + session id + file metadata.
    ///
    /// `compression` is a [`qr_protocol::compress`] tag (0=None, 1=Zstd, 2=Xz)
    /// identifying how `compressed_payload` was produced; the receiver runs the
    /// matching decompressor after RaptorQ recovery.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        compressed_payload: &[u8],
        session_id_lo: u64,
        session_id_hi: u64,
        redundancy_pct: u8,
        symbol_size: u32,
        filename: &str,
        original_file_size: u64,
        crc32: u32,
        compression: u8,
    ) -> Result<SenderSessionWasm, JsValue> {
        _start();
        let sid = SessionId(((session_id_hi as u64 as u128) << 64) | session_id_lo as u64 as u128);
        let cfg = SenderConfig {
            codec: Config { symbol_size },
            redundancy_pct,
        };
        let file_meta = crate::descriptor::FileMeta {
            filename: filename.to_string(),
            original_size: original_file_size,
            crc32,
            compression,
            compressed_size: compressed_payload.len() as u64,
            compressed_size_known: true,
            crc32_known: true,
        };
        let inner = SenderSession::new(compressed_payload, sid, cfg, file_meta).map_err(err_to_js)?;
        Ok(SenderSessionWasm { inner })
    }

    /// Produce the next frame's raw bytes (header + payload + footer).
    pub fn next_frame(&mut self) -> Result<Vec<u8>, JsValue> {
        let frame = self.inner.next_frame().map_err(err_to_js)?;
        Ok(frame.to_bytes())
    }

    /// Produce the next frame AND encode it to a QR matrix in one call.
    ///
    /// This fuses `next_frame()` + `encode_qr()` so the per-frame path crosses
    /// the WASM/JS boundary once instead of twice, avoiding the intermediate
    /// `Uint8Array` copy of the raw frame bytes (the JS layer never needs the
    /// raw frame — only the rendered matrix). Returns the flat module grid as
    /// `Vec<u8>` (1 = dark, 0 = light, row-major); `out_side[0]` is set to the
    /// side length. An empty `Vec` (side 0) signals the session produced no
    /// frame this tick.
    pub fn next_qr(&mut self, out_side: &mut [u32]) -> Result<Vec<u8>, JsValue> {
        if out_side.is_empty() {
            return Err(JsValue::from_str("out_side buffer empty"));
        }
        let frame = self.inner.next_frame().map_err(err_to_js)?;
        let bytes = frame.to_bytes();
        let matrix = crate::matrix_encode::encode_frame_matrix(&bytes).map_err(|e| {
            JsValue::from_str(&format!("qr encode failed: {e:?}"))
        })?;
        out_side[0] = matrix.size as u32;
        Ok(matrix.modules.iter().map(|&dark| dark as u8).collect())
    }

    /// Produce `count` next frames, each encoded to a QR matrix, in one WASM
    /// call — for the multi-QR-per-screen experimental mode. Each frame is a
    /// distinct symbol of the same session (different sbn/esi), so a receiver
    /// that decodes all on-screen codes at once gets `count` new symbols per
    /// tick instead of one, multiplying throughput by ~`count` (bounded by the
    /// camera resolving N smaller codes).
    ///
    /// Returns a flat little-endian buffer the JS layer parses:
    ///   `[u32 count_actual][for each matrix: u32 side + side*side bytes]`
    /// where each module byte is 1=dark / 0=light, row-major. `count_actual`
    /// may be less than `count` if the session could not produce that many
    /// (it should always be able to, since repair symbols are unbounded, but
    /// we clamp defensively). An empty buffer / count_actual == 0 signals
    /// failure.
    pub fn next_qr_multi(&mut self, count: u32) -> Result<Vec<u8>, JsValue> {
        // Cap at a sane maximum to bound allocation; the UI only offers 2/4.
        let n = count.min(8) as usize;
        let mut out: Vec<u8> = Vec::new();
        // Reserve the count slot; we'll fill it after we know how many succeeded.
        out.extend_from_slice(&0u32.to_le_bytes());
        let mut produced = 0u32;
        for _ in 0..n {
            let frame = match self.inner.next_frame() {
                Ok(f) => f,
                Err(e) => {
                    // Stop producing on error; return what we have so far.
                    android_log_wasm(&format!("next_qr_multi frame err: {e}"));
                    break;
                }
            };
            let bytes = frame.to_bytes();
            let matrix = match crate::matrix_encode::encode_frame_matrix(&bytes) {
                Ok(m) => m,
                Err(e) => {
                    android_log_wasm(&format!("next_qr_multi qr err: {e:?}"));
                    break;
                }
            };
            out.extend_from_slice(&(matrix.size as u32).to_le_bytes());
            out.extend(matrix.modules.iter().map(|&dark| dark as u8));
            produced += 1;
        }
        out[..4].copy_from_slice(&produced.to_le_bytes());
        Ok(out)
    }

    /// Zero-allocation variant of [`Self::next_qr`]: writes the matrix into the
    /// caller-supplied `out_modules` buffer instead of returning a fresh
    /// `Vec<u8>` that wasm-bindgen would deep-copy into a new JS `Uint8Array`.
    ///
    /// The caller must size `out_modules` to at least `side*side` bytes — the
    /// largest possible QR is Version 40 (177×177 = 31329 B), so a 32 KiB
    /// buffer is always safe. `out_side[0]` is set to the matrix side length.
    /// Returns the number of module bytes written (= `side*side`).
    ///
    /// Because the buffer is JS-owned (`&mut [u8]` is exposed as a `Uint8Array`
    /// view), writes land directly in the caller's `ArrayBuffer` with no
    /// per-frame allocation — this is the hot-path win for the render loop
    /// (240 encodes/s at 4-code×60fps).
    pub fn next_qr_into(
        &mut self,
        out_modules: &mut [u8],
        out_side: &mut [u32],
    ) -> Result<u32, JsValue> {
        if out_side.is_empty() {
            return Err(JsValue::from_str("out_side buffer empty"));
        }
        let frame = self.inner.next_frame().map_err(err_to_js)?;
        let bytes = frame.to_bytes();
        let matrix = crate::matrix_encode::encode_frame_matrix(&bytes)
            .map_err(|e| JsValue::from_str(&format!("qr encode failed: {e:?}")))?;
        let n = matrix.modules.len();
        if n > out_modules.len() {
            return Err(JsValue::from_str(&format!(
                "out_modules too small: need {n}, have {}",
                out_modules.len()
            )));
        }
        for (dst, &dark) in out_modules[..n].iter_mut().zip(matrix.modules.iter()) {
            *dst = dark as u8;
        }
        out_side[0] = matrix.size as u32;
        Ok(n as u32)
    }

    /// Zero-allocation variant of [`Self::next_qr_multi`]: writes the flat
    /// little-endian buffer into the caller-supplied `out_buf` instead of
    /// returning a fresh `Vec<u8>`.
    ///
    /// Buffer layout (same as `next_qr_multi`):
    ///   `[u32 count_actual][for each matrix: u32 side + side*side bytes]`
    /// Sizing: `4 + count * (4 + 177*177)` bytes is always safe (one u32 count
    /// slot + per-matrix header + largest-version matrix). For the UI's 4-code
    /// mode that is `4 + 4*(4+31329) ≈ 125 KiB`. Returns total bytes written.
    pub fn next_qr_multi_into(&mut self, count: u32, out_buf: &mut [u8]) -> Result<u32, JsValue> {
        let n = count.min(8) as usize;
        let mut pos: usize = 0;
        // Reserve and later backfill the count slot.
        if out_buf.len() < 4 {
            return Err(JsValue::from_str("out_buf too small for count slot"));
        }
        let count_slot = pos;
        pos += 4;
        let mut produced: u32 = 0;
        for _ in 0..n {
            let frame = match self.inner.next_frame() {
                Ok(f) => f,
                Err(e) => {
                    android_log_wasm(&format!("next_qr_multi_into frame err: {e}"));
                    break;
                }
            };
            let bytes = frame.to_bytes();
            let matrix = match crate::matrix_encode::encode_frame_matrix(&bytes) {
                Ok(m) => m,
                Err(e) => {
                    android_log_wasm(&format!("next_qr_multi_into qr err: {e:?}"));
                    break;
                }
            };
            let side_bytes = (matrix.size as u32).to_le_bytes();
            let need = 4 + matrix.modules.len();
            if pos + need > out_buf.len() {
                return Err(JsValue::from_str(&format!(
                    "out_buf overflow at matrix {}: need {need} at pos {pos}, have {}",
                    produced,
                    out_buf.len()
                )));
            }
            out_buf[pos..pos + 4].copy_from_slice(&side_bytes);
            pos += 4;
            for (dst, &dark) in out_buf[pos..pos + matrix.modules.len()]
                .iter_mut()
                .zip(matrix.modules.iter())
            {
                *dst = dark as u8;
            }
            pos += matrix.modules.len();
            produced += 1;
        }
        out_buf[count_slot..count_slot + 4].copy_from_slice(&produced.to_le_bytes());
        Ok(pos as u32)
    }

    /// Session id (low 64 bits).
    pub fn session_id_lo(&self) -> u64 {
        self.inner.session_id() as u64
    }
    pub fn session_id_hi(&self) -> u64 {
        (self.inner.session_id() >> 64) as u64
    }

    pub fn total_symbols(&self) -> u32 {
        self.inner.total_k()
    }
    pub fn num_blocks(&self) -> u32 {
        self.inner.num_blocks() as u32
    }

    /// Live stats as JSON: { bytes, frames, elapsed_ms, fps, throughput_bps }.
    pub fn stats_json(&self) -> String {
        let s = self.inner.stats();
        serde_json::json!({
            "bytes": s.bytes,
            "frames": s.frames,
            "elapsed_ms": s.elapsed_ms,
            "fps": s.fps(),
            "throughput_bps": s.throughput_bps(),
        })
        .to_string()
    }
}

fn err_to_js(e: crate::Error) -> JsValue {
    JsValue::from_str(&format!("{e}"))
}

/// Log a warning to the JS console (used by the multi-QR path on rare frame/QR
/// errors so they're visible without aborting the whole multi-frame tick).
fn android_log_wasm(msg: &str) {
    web_sys::console::warn_1(&format!("AirFerry: {msg}").into());
}

/// Encode `frame_bytes` (a serialized Frame) into a byte-mode EC-L QR matrix.
///
/// Returns the flat module grid as a `Uint8Array` of `side*side` bytes
/// (1 = dark, 0 = light), row-major. `out_side` is set to the side length.
#[wasm_bindgen]
pub fn encode_qr(frame_bytes: &[u8], out_side: &mut [u32]) -> Result<Vec<u8>, JsValue> {
    if out_side.is_empty() {
        return Err(JsValue::from_str("out_side buffer empty"));
    }
    let matrix = crate::matrix_encode::encode_frame_matrix(frame_bytes).map_err(|e| {
        JsValue::from_str(&format!("qr encode failed: {e:?}"))
    })?;
    out_side[0] = matrix.size as u32;
    Ok(matrix.modules.iter().map(|&dark| dark as u8).collect())
}

// serde_json is required by stats_json (serde_json::json!) and by the
// serde-derived ObjectMeta re-exported here. The `wasm` feature implies
// `serde` (see Cargo.toml), so no compile_error! guard is needed.

/// AFGrid side length for a symbol size (UI preview).
#[wasm_bindgen]
pub fn afgrid_side_for_symbol_size(symbol_size: u32) -> u32 {
    qr_protocol::afgrid::side_for_symbol_size(symbol_size) as u32
}
