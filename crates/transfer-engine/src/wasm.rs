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
            web_sys::console::error_1(&format!("EasyTransfer WASM panic: {info}").into());
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
        let sid = SessionId(((session_id_hi as u128) << 64) | session_id_lo as u128);
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
        };
        let inner = SenderSession::new(compressed_payload, sid, cfg, file_meta).map_err(err_to_js)?;
        Ok(SenderSessionWasm { inner })
    }

    /// Produce the next frame's raw bytes (header + payload + footer).
    pub fn next_frame(&mut self) -> Result<Vec<u8>, JsValue> {
        let frame = self.inner.next_frame().map_err(err_to_js)?;
        Ok(frame.to_bytes())
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

/// Encode `frame_bytes` (a serialized Frame) into a Version-40 / L QR matrix.
///
/// Returns the flat module grid as a `Uint8Array` of `side*side` bytes
/// (1 = dark, 0 = light), row-major. `out_side` is set to the side length.
#[wasm_bindgen]
pub fn encode_qr(frame_bytes: &[u8], out_side: &mut [u32]) -> Result<Vec<u8>, JsValue> {
    if out_side.is_empty() {
        return Err(JsValue::from_str("out_side buffer empty"));
    }
    let matrix = qr_protocol::qr_render::encode(frame_bytes).map_err(|e| {
        JsValue::from_str(&format!("qr encode failed: {e:?}"))
    })?;
    out_side[0] = matrix.size as u32;
    Ok(matrix.modules.iter().map(|&dark| dark as u8).collect())
}

// serde_json is only available with the `serde` feature; stats_json uses it.
// Re-assure the feature graph: stats_json compiles because serde feature is
// implied by the wasm build in practice. We guard explicitly:
#[cfg(not(feature = "serde"))]
compile_error!("transfer-engine 'wasm' feature requires 'serde' (add --features serde,wasm)");
