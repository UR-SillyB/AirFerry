//! WebAssembly bindings for AirFerry Protocol 2 (WASM).
//!
//! Exposes:
//! - [`SenderBuilderWasm`]: builds multi-entry AF2 streaming senders.
//! - [`SenderSessionWasm`]: high-throughput QR frame generator with preallocated
//!   scratch buffer for zero-copy Canvas rendering.
//! - [`ReceiverSessionWasm`]: AF2 stream receiver session (wraps [`crate::receiver::ReceiverSession`]).
//! - [`Blake3Wasm`]: BLAKE3-256 helper for single-pass hashing in web workers.
//! - [`encode_qr`]: direct QR matrix encoder.

#![cfg(all(feature = "wasm", target_arch = "wasm32"))]

use crate::receiver::ReceiverSession;
use af2::{
    plan_chunks as af2_plan_chunks, Af2Sender, PreencodedChunk, SenderConfig,
};
use wasm_bindgen::prelude::*;

const MAX_UI_QR_COUNT: usize = 4;
const MAX_SCRATCH_TILES: usize = 4;
const MAX_QR_SIDE_MODULES: usize = 177;
const QR_SCRATCH_BYTES: usize =
    4 + (MAX_SCRATCH_TILES * (4 + MAX_QR_SIDE_MODULES * MAX_QR_SIDE_MODULES));

#[wasm_bindgen]
pub struct Blake3Wasm {
    bytes: Vec<u8>,
}

impl Default for Blake3Wasm {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl Blake3Wasm {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }

    pub fn digest(&self) -> Vec<u8> {
        af2::id::hash(&self.bytes).to_vec()
    }
}

#[wasm_bindgen]
pub struct SenderBuilderWasm {
    items: Vec<(u8, String, Vec<u8>)>,
    /// Host pre-encoded chunks (balanced sender policy): `(chunk_index,
    /// codec_id, bytes)`; `codec_id == 0 && bytes.is_empty()` is the RAW
    /// marker ("compression cannot win — skip play-time attempts").
    preencoded: Vec<(u32, u8, Vec<u8>)>,
}

impl Default for SenderBuilderWasm {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl SenderBuilderWasm {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            preencoded: Vec::new(),
        }
    }

    pub fn add_entry(&mut self, kind: u8, path: &str, content: &[u8]) {
        self.items.push((kind, path.to_string(), content.to_vec()));
    }

    /// Provision one pre-encoded chunk (see [`af2::chunk::encode_chunk_balanced`]).
    /// Pass `codec_id = 0` with empty bytes for the RAW marker. The build
    /// fails if a provisioned chunk violates the §10.1 strictly-smaller
    /// invariant — a host bug never reaches the wire.
    pub fn add_preencoded_chunk(&mut self, index: u32, codec_id: u8, data: &[u8]) {
        self.preencoded.push((index, codec_id, data.to_vec()));
    }

    fn take_preencoded(&mut self) -> Vec<(u32, PreencodedChunk)> {
        std::mem::take(&mut self.preencoded)
            .into_iter()
            .map(|(index, codec, bytes)| {
                let pc = if codec == af2::meta::CODEC_RAW && bytes.is_empty() {
                    PreencodedChunk::RawMarker
                } else {
                    PreencodedChunk::Encoded(codec, bytes)
                };
                (index, pc)
            })
            .collect()
    }

    pub fn build(
        mut self,
        symbol_size: u32,
        chunk_raw_size: u32,
        redundancy_pct: u8,
    ) -> Result<SenderSessionWasm, JsValue> {
        let config = SenderConfig {
            symbol_size: symbol_size as usize,
            chunk_raw_size,
            redundancy_pct,
        };
        let preencoded = self.take_preencoded();
        let inner = Af2Sender::new_with_preencoded(self.items, config, preencoded)
            .map_err(|e| JsValue::from_str(&format!("AF2 Sender build failed: {e}")))?;
        Ok(SenderSessionWasm::from_inner(inner))
    }

    /// §9.3 resend-cache build: trust a previously computed encoded Manifest
    /// (hex, as returned by [`SenderSessionWasm::manifest_json`]) and skip the
    /// whole BLAKE3 hash pass. The host MUST key the cached manifest by
    /// `(path, size, mtime)` fingerprint and fall back to [`SenderBuilderWasm::build`]
    /// on cache miss or on any error returned here (SPEC §10.2: cache advisory).
    pub fn build_cached(
        mut self,
        manifest_hex: &str,
        symbol_size: u32,
        chunk_raw_size: u32,
        redundancy_pct: u8,
    ) -> Result<SenderSessionWasm, JsValue> {
        let bytes = hex_decode(manifest_hex)
            .map_err(|e| JsValue::from_str(&format!("AF2 cached manifest hex invalid: {e}")))?;
        let (manifest, _) = af2::manifest::Manifest::parse(&bytes)
            .map_err(|e| JsValue::from_str(&format!("AF2 cached manifest invalid: {e}")))?;
        let config = SenderConfig {
            symbol_size: symbol_size as usize,
            chunk_raw_size,
            redundancy_pct,
        };
        let preencoded = self.take_preencoded();
        let inner = Af2Sender::from_manifest_with_preencoded(manifest, self.items, config, preencoded)
            .map_err(|e| JsValue::from_str(&format!("AF2 cached sender build failed: {e}")))?;
        Ok(SenderSessionWasm::from_inner(inner))
    }
}

#[wasm_bindgen]
pub struct SenderSessionWasm {
    inner: Af2Sender,
    qr_scratch: Vec<u8>,
    frames_emitted: u64,
    bytes_emitted: u64,
    start_time_ms: f64,
}

#[wasm_bindgen]
impl SenderSessionWasm {
    fn from_inner(inner: Af2Sender) -> Self {
        Self {
            inner,
            qr_scratch: vec![0; QR_SCRATCH_BYTES],
            frames_emitted: 0,
            bytes_emitted: 0,
            start_time_ms: js_sys::Date::now(),
        }
    }

    pub fn transfer_id_hex(&self) -> String {
        hex_lower(&self.inner.transfer_id())
    }

    pub fn content_id_hex(&self) -> String {
        hex_lower(&self.inner.content_id())
    }

    /// Encoded Manifest bytes as hex — the §9.3 resend-cache payload. Store it
    /// keyed by the transfer fingerprint `(path, size, mtime)`, then hand it
    /// back to `SenderBuilderWasm.build_cached` on resend to skip the BLAKE3
    /// hash pass entirely (SPEC §10.2).
    pub fn manifest_json(&self) -> String {
        hex_lower(self.inner.manifest_bytes())
    }

    pub fn stats_json(&self) -> String {
        let now = js_sys::Date::now();
        let elapsed_ms = (now - self.start_time_ms).max(1.0);
        let fps = (self.frames_emitted as f64) / (elapsed_ms / 1000.0);
        let throughput_bps = (self.bytes_emitted as f64) / (elapsed_ms / 1000.0);
        format!(
            r#"{{"frames":{},"fps":{:.1},"throughput_bps":{:.0},"bytes":{},"elapsed_ms":{:.0}}}"#,
            self.frames_emitted, fps, throughput_bps, self.bytes_emitted, elapsed_ms
        )
    }

    pub fn next_qr_scratch(&mut self, count: u32) -> Result<u32, JsValue> {
        let n = (count as usize).clamp(1, MAX_UI_QR_COUNT);
        let mut pos = 4usize;
        let mut produced = 0u32;
        for _ in 0..n {
            let frame_bytes = self
                .inner
                .next_frame()
                .map_err(|e| JsValue::from_str(&format!("AF2 frame generation failed: {e}")))?;
            self.frames_emitted += 1;
            self.bytes_emitted += frame_bytes.len() as u64;
            let matrix = qr_protocol::qr_render::encode(&frame_bytes)
                .map_err(|e| JsValue::from_str(&format!("qr encode failed: {e:?}")))?;
            let need = 4 + matrix.modules.len();
            if pos + need > self.qr_scratch.len() {
                return Err(JsValue::from_str("internal QR scratch buffer overflow"));
            }
            self.qr_scratch[pos..pos + 4].copy_from_slice(&(matrix.size as u32).to_le_bytes());
            pos += 4;
            for (dst, &dark) in self.qr_scratch[pos..pos + matrix.modules.len()]
                .iter_mut()
                .zip(matrix.modules.iter())
            {
                *dst = dark as u8;
            }
            pos += matrix.modules.len();
            produced += 1;
        }
        self.qr_scratch[..4].copy_from_slice(&produced.to_le_bytes());
        Ok(pos as u32)
    }

    /// View over the internal scratch buffer. The view is invalidated by the
    /// next `next_qr_scratch` call (same buffer is overwritten in place) —
    /// consume it immediately, never cache it across frames.
    pub fn qr_scratch_view(&self) -> js_sys::Uint8Array {
        unsafe { js_sys::Uint8Array::view(&self.qr_scratch) }
    }
}

#[wasm_bindgen]
pub struct ReceiverSessionWasm {
    inner: ReceiverSession,
}

impl Default for ReceiverSessionWasm {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl ReceiverSessionWasm {
    #[wasm_bindgen(constructor)]
    pub fn new() -> ReceiverSessionWasm {
        ReceiverSessionWasm {
            inner: ReceiverSession::new(),
        }
    }

    /// Ingest a frame. Returns the unified packed `u64` ingest status word as
    /// a JavaScript `BigInt` (SPEC §16, identical to JNI and C-ABI layout).
    pub fn ingest(&mut self, frame_bytes: &[u8]) -> u64 {
        self.inner.ingest(frame_bytes)
    }

    /// True once all chunks of the transfer have been verified and staged.
    pub fn is_complete(&self) -> bool {
        self.inner.is_complete()
    }

    /// Index of the chunk completed by the most recent ChunkReady frame (or 0).
    pub fn last_chunk_index(&self) -> u32 {
        self.inner.last_completed_chunk_index().unwrap_or(0)
    }

    /// Bytes of a completed chunk currently in memory (or empty if evicted).
    pub fn assemble_chunk(&mut self, index: u32) -> Vec<u8> {
        self.inner.assemble_chunk(index).unwrap_or_default()
    }

    /// Release chunk memory once persisted to host storage (OPFS / IndexedDB).
    pub fn forget_chunk(&mut self, index: u32) -> bool {
        self.inner.forget_chunk(index)
    }

    /// Verify a staged raw chunk against the ROOT-bound Manifest table (§11).
    pub fn verify_chunk(&self, index: u32, raw: &[u8]) -> bool {
        self.inner.verify_chunk(index, raw)
    }

    /// Run the final §13 ⑧⑨ integrity chain over the reassembled canonical stream.
    pub fn verify_final_stream(&self, stream: &[u8]) -> bool {
        self.inner.verify_final_stream(stream)
    }

    /// Begin bounded-memory §13 ⑧⑨ verification.
    pub fn final_verify_begin(&mut self) -> bool {
        self.inner.final_verify_begin()
    }

    /// Feed the next contiguous canonical-stream block.
    pub fn final_verify_feed(&mut self, stream: &[u8]) -> bool {
        self.inner.final_verify_feed(stream)
    }

    /// Finish bounded-memory §13 ⑧⑨ verification.
    pub fn final_verify_finish(&mut self) -> bool {
        self.inner.final_verify_finish()
    }

    /// Restore session state from stored ROOT frame bytes + completed chunk indices.
    pub fn resume(&mut self, root_frame_bytes: &[u8], completed: &[u32]) -> bool {
        self.inner.resume(root_frame_bytes, completed)
    }

    /// Evict one chunk from both ledgers after a spill re-verification
    /// failure (§11/§12): the sender's next epoch re-supplies it.
    pub fn invalidate_chunk(&mut self, index: u32) -> bool {
        self.inner.invalidate_chunk(index)
    }

    /// Single-JSON receiver snapshot (`schema_version: 2`).
    pub fn snapshot_json(&self) -> String {
        self.inner.snapshot_json()
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let nib = |c: u8| -> Result<u8, String> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(format!("invalid hex digit {:?}", c as char)),
        }
    };
    for i in (0..s.len()).step_by(2) {
        let hi = nib(s.as_bytes()[i])?;
        let lo = nib(s.as_bytes()[i + 1])?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

#[wasm_bindgen]
pub fn encode_qr(frame_bytes: &[u8], out_side: &mut [u32]) -> Result<Vec<u8>, JsValue> {
    let matrix = qr_protocol::qr_render::encode(frame_bytes)
        .map_err(|e| JsValue::from_str(&format!("qr encode failed: {e:?}")))?;
    if !out_side.is_empty() {
        out_side[0] = matrix.size as u32;
    }
    Ok(matrix.modules.into_iter().map(|b| b as u8).collect())
}

/// Result of [`encode_chunk_balanced`]: the chosen wire `codec_id` (0=RAW,
/// 1=Zstd, 2=Xz) and the encoded bytes. A RAW result means "ship the raw
/// slice" — hosts pass it to `add_preencoded_chunk` as the empty RAW marker
/// instead of copying the bytes back.
#[wasm_bindgen]
pub struct EncodedChunkWasm {
    codec: u8,
    data: Vec<u8>,
}

#[wasm_bindgen]
impl EncodedChunkWasm {
    #[wasm_bindgen(getter)]
    pub fn codec_id(&self) -> u8 {
        self.codec
    }

    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Vec<u8> {
        self.data.clone()
    }
}

/// Balanced per-chunk encode for the host prep pass (SPEC §10.1 sender
/// policy; see `af2::chunk::encode_chunk_balanced` for the three rules).
/// `channel_bps` is the playout payload rate (fps × T × QR count); 0
/// disables escalation. `force_full` escalates unconditionally (use for
/// single-chunk transfers).
#[wasm_bindgen]
pub fn encode_chunk_balanced(
    raw: &[u8],
    channel_bps: u64,
    force_full: bool,
) -> EncodedChunkWasm {
    let (codec, data) = af2::chunk::encode_chunk_balanced(raw, channel_bps, force_full);
    EncodedChunkWasm { codec, data }
}

/// Canonical-stream chunk layout without reading content (see
/// `af2::sender::plan_chunks`). `kinds`/`paths`/`sizes` are parallel arrays
/// over the SAME item list that will be `add_entry`'d; `sizes[i]` is item i's
/// content length in bytes. Returns JSON: `{"chunks":[[i,s,l, i,s,l, …], …]}`
/// — per chunk, a flat triple list of `(item index, offset in item, length)`.
#[wasm_bindgen]
pub fn plan_chunks(
    kinds: Vec<u8>,
    paths: Vec<String>,
    sizes: Vec<f64>,
    chunk_raw_size: u32,
) -> Result<String, JsValue> {
    if kinds.len() != paths.len() || kinds.len() != sizes.len() {
        return Err(JsValue::from_str(
            "plan_chunks: kinds/paths/sizes length mismatch",
        ));
    }
    // f64→u64 must be checked before the cast (§3 checked arithmetic).
    const MAX_TOTAL: f64 = 4.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0;
    for (i, &s) in sizes.iter().enumerate() {
        if !(s.is_finite() && s >= 0.0 && s <= MAX_TOTAL) {
            return Err(JsValue::from_str(&format!(
                "plan_chunks: item {i} size {s} out of range"
            )));
        }
    }
    let metas: Vec<(u8, String, u64)> = kinds
        .into_iter()
        .zip(paths)
        .zip(sizes)
        .map(|((k, p), s)| (k, p, s as u64))
        .collect();
    let chunks = af2_plan_chunks(&metas, chunk_raw_size)
        .map_err(|e| JsValue::from_str(&format!("plan_chunks failed: {e}")))?;
    let mut out = String::from("{\"chunks\":[");
    for (ci, chunk) in chunks.iter().enumerate() {
        if ci > 0 {
            out.push(',');
        }
        out.push('[');
        for (si, seg) in chunk.iter().enumerate() {
            if si > 0 {
                out.push(',');
            }
            out.push_str(&format!("{},{},{}", seg.item, seg.start, seg.len));
        }
        out.push(']');
    }
    out.push_str("]}");
    Ok(out)
}
