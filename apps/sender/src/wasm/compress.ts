/**
 * Compression helper for the browser sender.
 *
 * The browser cannot link the native zstd / liblzma C libraries to
 * wasm32-unknown-unknown, so compression is performed here in JS via WASM
 * modules. The outputs are standard zstd frames / .xz streams respectively, so
 * the Rust receiver decompresses them with the exact same codecs it uses for
 * native/Android payloads.
 *
 * ## Three-way algorithm selection (pick the smallest)
 *
 * All algorithms run at their maximum level and the smallest result wins:
 *
 *   - **raw**  — the original bytes, uncompressed.
 *   - **zstd** — level 22 (the maximum zstd level).
 *   - **xz**   — level 9 (the maximum LZMA2 preset).
 *
 * Whichever produces the fewest bytes is shipped. Already-compressed files
 * (jpeg, mp4, zip, …) thus naturally fall back to raw, while text-heavy files
 * benefit from xz's superior ratio.
 *
 * **Time-saving early exit:** xz (LZMA2 at level 9) is much slower than zstd.
 * To avoid spending it on data that won't benefit, zstd is run first; if its
 * result is ≥ 95% of the original size the file is treated as already
 * compressed and xz is skipped. The final comparison then picks the smallest
 * among whichever candidates actually ran (2 or 3). The chosen algorithm tag
 * is carried in the session descriptor (protocol v3), telling the receiver
 * which decompressor to run after RaptorQ recovery.
 *
 * ## CSP / WASM loading
 *
 * The zstd `.wasm` is copied into the extension build output by a post-build
 * script (see package.json "build:copy-wasm") and fetched at runtime via
 * chrome.runtime.getURL() + WebAssembly.instantiate — fully CSP-safe under
 * Chrome MV3's `wasm-unsafe-eval`. `lzma-wasm` bundles its own loader.
 */

/** Whether the sender compresses payload before encoding. */
export const COMPRESSION_ENABLED = true

/**
 * Compression-algorithm tag. Mirrors `qr_protocol::compress` constants so the
 * byte written into the descriptor matches what the Rust receiver expects.
 */
export const enum CompressionAlgorithm {
  None = 0,
  Zstd = 1,
  Xz = 2
}

/** Fast zstd level (1). Speeds up compression start. */
const ZSTD_LEVEL = 1
/** Maximum XZ/LZMA2 preset level (9). */
const XZ_LEVEL = 9
/**
 * Early-exit threshold. Only run the slow xz pass when zstd compresses
 * below 70 % of the original — a strong signal the file is genuinely
 * compressible enough that xz's better ratio is worth the time.
 */
const ZSTD_ALREADY_COMPRESSED_RATIO = 0.70

export interface PrepareResult {
  payload: Uint8Array
  algorithm: CompressionAlgorithm
  originalSize: number
  compressedSize: number
}

// ---------------------------------------------------------------------------
// zstd WASM module management — load once, reuse for all compressions
// ---------------------------------------------------------------------------

interface ZstdWasmModule {
  memory: WebAssembly.Memory
  _malloc: (size: number) => number
  _free: (ptr: number) => void
  _compressBound: (srcSize: number) => number
  _compress: (
    dst: number, dstCap: number,
    src: number, srcSize: number,
    level: number
  ) => number
}

/**
 * Pre-loaded WASM bytes, set from the main thread (see initZstdFromBytes).
 * When set, loadWasm uses these bytes instead of fetching via chrome.runtime,
 * which is critical when running inside a Web Worker where chrome.runtime.getURL
 * may not be reliably available (the root cause of the "always 100% ratio" bug).
 */
let preloadedWasmBytes: ArrayBuffer | null = null

/** Resolve to the loaded WASM instance (singleton). */
let wasmInitPromise: Promise<ZstdWasmModule> | null = null

/**
 * The emscripten WASM module imports "a.a" (_emscripten_memcpy_big) and
 * "a.b" (_emscripten_resize_heap). We provide minimal stubs.
 */
interface EmscriptenImportCtx {
  memory: WebAssembly.Memory | null
}

function createEmscriptenImports(): { imports: WebAssembly.Imports; ctx: EmscriptenImportCtx } {
  const ctx: EmscriptenImportCtx = { memory: null }

  const imports: WebAssembly.Imports = {
    a: {
      // "a" → _emscripten_resize_heap(requestedSize)
      a: (requestedSize: number) => {
        if (!ctx.memory) return 0
        const oldSize = ctx.memory.buffer.byteLength
        if (requestedSize <= oldSize) return 1
        const neededPages = Math.ceil((requestedSize - oldSize) / 65536)
        try {
          ctx.memory.grow(neededPages)
          return 1
        } catch {
          return 0
        }
      },
      // "b" → _emscripten_memcpy_big(dest, src, num)
      b: (dest: number, src: number, num: number) => {
        if (!ctx.memory) return
        new Uint8Array(ctx.memory.buffer).copyWithin(dest, src, src + num)
      }
    }
  }

  return { imports, ctx }
}

/** Instantiate zstd WASM from raw bytes. Shared by loadWasm and initZstdFromBytes. */
async function instantiateZstd(buffer: ArrayBuffer): Promise<ZstdWasmModule> {
  const { imports, ctx } = createEmscriptenImports()

  const { instance } = await WebAssembly.instantiate(buffer, imports)
  // Wire the module's own memory into our import stubs.
  ctx.memory = instance.exports.c as WebAssembly.Memory

  // Run C global constructors
  const callCtors = instance.exports.d as () => number
  callCtors()

  return {
    memory: ctx.memory,
    _malloc: instance.exports.f as ZstdWasmModule["_malloc"],
    _free: instance.exports.g as ZstdWasmModule["_free"],
    _compressBound: instance.exports.h as ZstdWasmModule["_compressBound"],
    _compress: instance.exports.i as ZstdWasmModule["_compress"],
  }
}

/**
 * Initialize the zstd WASM module from pre-loaded bytes (sent from the main
 * thread). Call this BEFORE any compression request. Once set, the bytes are
 * used instead of fetching via chrome.runtime.getURL, making the worker safe.
 */
export function initZstdFromBytes(bytes: ArrayBuffer): void {
  preloadedWasmBytes = bytes
  // Reset so the next getWasm() call uses these bytes
  wasmInitPromise = null
}

function loadWasm(): Promise<ZstdWasmModule> {
  // If we have pre-loaded bytes (sent from main thread), use them directly,
  // bypassing chrome.runtime.getURL which may not work reliably in a worker.
  if (preloadedWasmBytes) {
    return instantiateZstd(preloadedWasmBytes).catch((e) => {
      console.error("Zstd WASM instantiation from pre-loaded bytes failed:", e)
      // fall through to the fetch path
      return fetchAndInstantiate()
    })
  }

  return fetchAndInstantiate()
}

function fetchAndInstantiate(): Promise<ZstdWasmModule> {
  // Fallback: fetch via chrome.runtime.getURL (works on main thread)
  const wasmUrl =
    typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL("wasm-zstd.wasm")
      : // Worker fallback: resolve relative to worker location
        new URL("wasm-zstd.wasm", self.location.href).href

  return fetch(wasmUrl, { credentials: "same-origin" })
    .then((resp) => {
      if (!resp.ok) throw new Error(`Failed to fetch wasm-zstd.wasm: ${resp.status}`)
      return resp.arrayBuffer()
    })
    .then((buffer) => instantiateZstd(buffer))
}

async function getWasm(): Promise<ZstdWasmModule> {
  if (!wasmInitPromise) {
    wasmInitPromise = loadWasm()
  }
  return wasmInitPromise
}

/**
 * Compress `data` with zstd at max level using the WASM module.
 */
function compressWithWasm(wasm: ZstdWasmModule, data: Uint8Array): Uint8Array {
  const srcSize = data.byteLength
  const dstCap = wasm._compressBound(srcSize)
  const srcPtr = wasm._malloc(srcSize)
  const dstPtr = wasm._malloc(dstCap)

  try {
    new Uint8Array(wasm.memory.buffer, srcPtr, srcSize).set(data)

    const resultSize = wasm._compress(dstPtr, dstCap, srcPtr, srcSize, ZSTD_LEVEL)
    if (resultSize === -1 || resultSize <= 0) {
      throw new Error(`Zstd compress returned ${resultSize}`)
    }

    return new Uint8Array(wasm.memory.buffer, dstPtr, resultSize).slice()
  } finally {
    wasm._free(srcPtr)
    wasm._free(dstPtr)
  }
}

// ---------------------------------------------------------------------------
// lzma-wasm (XZ) module management
// ---------------------------------------------------------------------------

import { initWasm as initLzma, compress as lzmaCompress } from "lzma-wasm"

let lzmaInitPromise: Promise<void> | null = null

/** Initialize the lzma-wasm module exactly once. */
function ensureLzma(): Promise<void> {
  if (!lzmaInitPromise) {
    lzmaInitPromise = initLzma().then(() => undefined)
  }
  return lzmaInitPromise
}

/**
 * Compress `data` with XZ/LZMA2 at the configured level. Returns a standard
 * `.xz` stream that the Android `xz2` decoder can decompress.
 */
async function compressXz(data: Uint8Array): Promise<Uint8Array> {
  await ensureLzma()
  return lzmaCompress(data, { format: "xz", level: XZ_LEVEL })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pick the smallest payload among raw / zstd / xz.
 *
 * Strategy (see module docs): all algorithms run at their maximum level;
 * whichever produced the fewest bytes is shipped. To save time, xz (the
 * slowest) is skipped when zstd's result is ≥ 95% of the original — a strong
 * signal the file is already compressed and xz won't help. The final pick is
 * then the minimum over whichever candidates actually ran (2 or 3).
 *
 * Always returns a transmissible payload, falling back to the raw bytes on any
 * compression failure.
 *
 * @param onProgress Optional stage callback. Invoked when each compress phase
 *   completes (`"zstd"` after the zstd pass, `"xz"` after the xz pass). Used by
 *   the compress worker to report stage progress to the UI. The compress itself
 *   is synchronous WASM, so no mid-phase percentage is possible — the callback
 *   only marks phase boundaries. Omitting it preserves the original behaviour.
 */
export async function preparePayload(
  data: Uint8Array,
  onProgress?: (phase: "zstd" | "xz") => void
): Promise<PrepareResult> {
  const originalSize = data.length
  if (!COMPRESSION_ENABLED || originalSize === 0) {
    return {
      payload: data,
      algorithm: CompressionAlgorithm.None,
      originalSize,
      compressedSize: originalSize
    }
  }

  const input =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data
      : new Uint8Array(data)

  // raw is always a candidate — used when every compressor fails to shrink.
  const candidates: Array<{ payload: Uint8Array; algorithm: CompressionAlgorithm }> = [
    { payload: data, algorithm: CompressionAlgorithm.None }
  ]

  // --- zstd pass (fast, always run) ---
  // Report the phase BEFORE running the (synchronous) compressor, so the UI
  // shows "正在压缩 zstd" while it runs — not only after it finishes.
  onProgress?.("zstd")
  try {
    const wasm = await getWasm()
    const c = compressWithWasm(wasm, input)
    if (c.length < originalSize) {
      candidates.push({ payload: c, algorithm: CompressionAlgorithm.Zstd })
    }
  } catch (e) {
    console.warn("Zstd compression failed:", e)
  }

  const zstdSize = candidates.length > 1 ? candidates[1].payload.length : originalSize

  // --- time-saving early exit ---
  // zstd barely shrank the file (≥ 95% of original) → it's already compressed.
  // Skip the expensive xz pass; pick the smaller of raw / zstd only.
  if (zstdSize / originalSize >= ZSTD_ALREADY_COMPRESSED_RATIO) {
    return pickSmallest(candidates, originalSize)
  }

  // --- xz pass (slow, only when the file is genuinely compressible) ---
  // Report BEFORE running xz (it can take seconds on text-heavy files), so the
  // UI step list marks zstd done and xz active while it runs.
  onProgress?.("xz")
  try {
    const c = await compressXz(input)
    if (c.length < originalSize) {
      candidates.push({ payload: c, algorithm: CompressionAlgorithm.Xz })
    }
  } catch (e) {
    console.warn("XZ compression failed:", e)
  }

  // Pick the smallest of raw / zstd / xz.
  return pickSmallest(candidates, originalSize)
}

/** Choose the smallest candidate and build the result. Logs the decision. */
function pickSmallest(
  candidates: Array<{ payload: Uint8Array; algorithm: CompressionAlgorithm }>,
  originalSize: number
): PrepareResult {
  let best = candidates[0]
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].payload.length < best.payload.length) {
      best = candidates[i]
    }
  }
  const size = best.payload.length
  const algoName =
    best.algorithm === CompressionAlgorithm.None
      ? "raw"
      : best.algorithm === CompressionAlgorithm.Zstd
        ? "zstd"
        : "xz"
  const ratio = originalSize > 0 ? ((size / originalSize) * 100).toFixed(1) : "0"
  console.log(
    `Compression: ${originalSize} → ${size} bytes via ${algoName} (${ratio}%, ` +
      `compared ${candidates.length} candidates)`
  )
  return {
    payload: best.payload,
    algorithm: best.algorithm,
    originalSize,
    compressedSize: size
  }
}
