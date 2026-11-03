/**
 * QR decode worker — decodes QR codes from a captured video frame.
 *
 * Two backends:
 *  - FAST (default, M3): self-compiled ZXing-C++ → WASM (`fastzxing/`), reads a
 *    raw Y (luminance) plane — no RGBA conversion, ~4× less data, -O3 scalar.
 *  - COMPAT (fallback): `zxing-wasm` npm package, reads RGBA ImageData.
 *
 * The worker auto-probes the fast module on `init`; if it loads it reports
 * `{type:"ready", fast:true}` and the main thread then feeds Y planes via
 * `VideoFrame.copyTo(I420)`. If the fast module is missing/failed, it falls
 * back to zxing-wasm and reports `{type:"ready", fast:false}`; the main thread
 * then feeds RGBA as before.
 *
 * ## Protocol
 * - main → `{type:"init"}`: load fast backend (probe), else zxing-wasm
 * - main → `{type:"decode", width, height, yPlane?, rgba?, format:"Y"|"RGBA", jobId}`
 * - worker → `{type:"ready", fast}` / `{type:"decoded", payloads, jobId}` /
 *   `{type:"error", message}`
 *
 * One frame in flight per worker (the pool keeps N frames across cores).
 */

/// <reference lib="webworker" />

import { base64ToBuffer } from "@/wasm/base64"

/**
 * Single-file (standalone) build constants. The standalone post-processor
 * prepends these to this worker's source: the Emscripten glue source, the FAST
 * ZXing wasm as base64, and the compat `zxing_reader.wasm` as base64. Under
 * `file://` neither `new URL("../airferry_zxing.js", ...)` nor a relative
 * `locateFile` can resolve, so both backends consume the inlined bytes.
 */
const standaloneGlobals = globalThis as {
  __AIRFERRY_STANDALONE__?: boolean
  __ZXING_FAST_JS__?: string
  __ZXING_FAST_WASM__?: string
  __ZXING_READER_WASM__?: string
}

let ready = false
let readyPromise: Promise<void> | null = null
// Keep the standalone FAST wasm's Blob URL alive: Emscripten calls
// findWasmBinary() (which consults locateFile) even when wasmBinary is set.
let standaloneFastWasmUrl: string | null = null

/** Self-compiled fast backend state. */
let fastOk = false
let fastMod: {
  _airferry_wasm_decode_multi_y(
    p: number,
    len: number,
    w: number,
    h: number,
    stride: number,
    outLen: number
  ): number
  _airferry_wasm_free(p: number): void
  _airferry_wasm_abi_version(): number
  _malloc(n: number): number
  _free(p: number): void
  HEAPU8: Uint8Array
  HEAPU32: Uint32Array
} | null = null

/** Try to load the self-compiled ZXing-C++ WASM (fast backend). */
async function loadFastBackend(): Promise<boolean> {
  try {
    type FastFactory = (overrides?: {
      wasmBinary?: Uint8Array
      locateFile?: (path: string, prefix: string) => string
    }) => Promise<unknown>
    let factory: FastFactory
    let overrides: {
      wasmBinary?: Uint8Array
      locateFile?: (path: string, prefix: string) => string
    } | undefined

    const standalone = standaloneGlobals.__AIRFERRY_STANDALONE__ === true
    const hasInlinedFast = Boolean(
      standaloneGlobals.__ZXING_FAST_JS__ &&
        standaloneGlobals.__ZXING_FAST_WASM__
    )
    // A standalone build may intentionally ship without the optional FAST
    // artifact; go straight to compat instead of resolving a public path that
    // cannot exist under file://.
    if (standalone && !hasInlinedFast) return false

    if (standalone && hasInlinedFast) {
      // file:// cannot resolve the public airferry_zxing.js path. Import the
      // inlined glue from a Blob URL and hand the wasm bytes to Emscripten's
      // wasmBinary hook so it never fetches. locateFile is also supplied because
      // findWasmBinary() runs before instantiation and would otherwise resolve
      // a relative path against the Blob module URL (invalid base → TypeError).
      const wasm = base64ToBuffer(standaloneGlobals.__ZXING_FAST_WASM__)
      if (!wasm) return false
      const wasmBytes = new Uint8Array(wasm)
      standaloneFastWasmUrl ??= URL.createObjectURL(
        new Blob([wasmBytes], { type: "application/wasm" })
      )
      const wasmUrl = standaloneFastWasmUrl
      const jsUrl = URL.createObjectURL(
        new Blob([standaloneGlobals.__ZXING_FAST_JS__], {
          type: "text/javascript",
        })
      )
      try {
        const mod = await import(/* @vite-ignore */ jsUrl)
        factory = mod.default as FastFactory
      } finally {
        URL.revokeObjectURL(jsUrl)
      }
      overrides = {
        wasmBinary: wasmBytes,
        locateFile: () => wasmUrl,
      }
    } else {
      // The fast backend is an optional generated artifact (build-fastzxing.sh,
      // git-ignored). In the web receiver build it is copied to the site root
      // (public/) by prepare-wasm.cjs; at runtime this worker lives at
      // assets/<hash>.js, so "../airferry_zxing.js" resolves to the site root —
      // the same mechanism zxing-wasm's locateFile uses for zxing_reader.wasm.
      // Keep @vite-ignore so Vite doesn't try to bundle it (it's a public
      // runtime asset); builds without the artifact still ship the fallback.
      const moduleUrl = new URL("../airferry_zxing.js", self.location.href).href
      const mod = await import(/* @vite-ignore */ moduleUrl)
      factory = mod.default as FastFactory
    }

    const inst = await factory(overrides)
    const m = inst as typeof fastMod
    if (!m || m._airferry_wasm_abi_version() !== 1) return false
    fastMod = m
    fastOk = true
    return true
  } catch (error) {
    if (standaloneGlobals.__AIRFERRY_STANDALONE__) {
      console.warn(
        "[qr] standalone FAST ZXing failed; using zxing-wasm compat:",
        error
      )
    }
    return false
  }
}

/** Decode all QR codes in a Y (luminance) plane using the fast backend. */
function decodeFastY(
  yPlane: Uint8Array,
  w: number,
  h: number,
  rowStride: number
): Uint8Array[] {
  const payloads: Uint8Array[] = []
  if (!fastMod) return payloads
  const srcPtr = fastMod._malloc(yPlane.length)
  const lenPtr = fastMod._malloc(8)
  // Wrap the decode + parse in try/finally so the two input allocations are
  // released even if _airferry_wasm_decode_multi_y traps (a WASM trap on a
  // malformed/corrupt luminance plane is rare but possible). The WASM heap only
  // grows, never shrinks, so leaking w*h+8 bytes per trap would accumulate
  // unbounded over a long scan session.
  try {
    fastMod.HEAPU8.set(yPlane, srcPtr)
    fastMod.HEAPU32[lenPtr >> 2] = 0
    fastMod.HEAPU32[(lenPtr >> 2) + 1] = 0
    const outPtr = fastMod._airferry_wasm_decode_multi_y(
      srcPtr,
      yPlane.length,
      w,
      h,
      rowStride,
      lenPtr
    )
    const outLen = fastMod.HEAPU32[lenPtr >> 2]
    if (outPtr !== 0 && outLen > 0) {
      const packed = fastMod.HEAPU8.subarray(outPtr, outPtr + outLen)
      const count = packed[0] | (packed[1] << 8) | (packed[2] << 16) | (packed[3] << 24)
      let off = 4
      for (let i = 0; i < count; i++) {
        const len =
          packed[off] | (packed[off + 1] << 8) | (packed[off + 2] << 16) | (packed[off + 3] << 24)
        off += 4
        if (len >= 64) payloads.push(packed.slice(off, off + len))
        off += len + 16 // payload + 4×s32 bbox
      }
      fastMod._airferry_wasm_free(outPtr)
    }
  } finally {
    fastMod._free(srcPtr)
    fastMod._free(lenPtr)
  }
  return payloads
}

/**
 * zxing-wasm's default `locateFile` resolves `*_*.wasm` to a jsDelivr CDN URL,
 * which breaks AirFerry's fully-offline requirement (and may be blocked by
 * CSP / the Great Firewall). AirFerry copies `zxing_reader.wasm` to the site
 * root at build time (`prepare-wasm.cjs` → `public/`); this worker runs under
 * `assets/`, so `../zxing_reader.wasm` relative to the worker script reaches it.
 * The relative URL also keeps arbitrary-subpath deployments working (`base:"./"`).
 */

/** Crop a rectangular region out of a full-frame RGBA buffer (row-major). */
function cropRgba(
  rgba: Uint8Array,
  srcW: number,
  x: number,
  y: number,
  w: number,
  h: number
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * srcW + x) * 4
    const dstStart = row * w * 4
    out.set(rgba.subarray(srcStart, srcStart + w * 4), dstStart)
  }
  return out
}

// Keep the inlined compat wasm's Blob URL alive for the module lifetime: the
// Emscripten glue resolves it lazily and may request it more than once.
let standaloneReaderWasmUrl: string | null = null

/** Load the compat backend (zxing-wasm) as a fallback. */
async function ensureZxingWasm(): Promise<void> {
  if (ready) return
  if (!readyPromise) {
    readyPromise = (async () => {
      // `zxing-wasm/reader` is the decode-only subpath (smaller WASM). It
      // exposes readBarcodesFromImageData which accepts ImageData directly.
      const zxing = await import("zxing-wasm/reader")
      let locateFile = (file: string) =>
        new URL("../" + file, self.location.href).href
      if (
        standaloneGlobals.__AIRFERRY_STANDALONE__ &&
        standaloneGlobals.__ZXING_READER_WASM__
      ) {
        const wasm = base64ToBuffer(standaloneGlobals.__ZXING_READER_WASM__)
        if (wasm) {
          standaloneReaderWasmUrl ??= URL.createObjectURL(
            new Blob([wasm], { type: "application/wasm" })
          )
          const url = standaloneReaderWasmUrl
          locateFile = () => url
        }
      }
      await zxing.getZXingModule({ locateFile })
      ready = true
    })().catch((e) => {
      readyPromise = null
      throw e
    })
  }
  return readyPromise
}

function post(msg: unknown): void {
  ;(postMessage as (m: unknown) => void)(msg)
}

self.addEventListener("message", async (e: MessageEvent) => {
  const data = e.data
  if (!data || typeof data !== "object") return

  if (data.type === "init") {
    try {
      // Auto-probe: prefer the self-compiled fast backend (Y-plane decode).
      fastOk = await loadFastBackend()
      if (fastOk) {
        post({ type: "ready", fast: true })
        return
      }
      // Fallback: zxing-wasm (RGBA).
      await ensureZxingWasm()
      post({ type: "ready", fast: false })
    } catch (err) {
      post({ type: "error", message: `解码器加载失败: ${String(err)}` })
    }
    return
  }

  if (data.type === "decode") {
    if (!ready && !fastOk) return // drop until a backend is ready
    const { width, height, rgba, yPlane, format, jobId, roiGrid } = data as {
      width: number
      height: number
      rgba?: Uint8Array
      yPlane?: Uint8Array
      format?: "Y" | "RGBA"
      jobId: number
      roiGrid?: { cols: number; rows: number }
    }
    try {
      // Fast backend: feed the raw Y (luminance) plane — no RGBA conversion.
      if (fastOk && format === "Y" && yPlane) {
        const payloads = decodeFastY(yPlane, width, height, width)
        post({ type: "decoded", payloads, jobId })
        return
      }
      const zxing = await import("zxing-wasm/reader")
      // Wrap the RGBA buffer (if provided) or fall back to an empty frame.
      const rg = rgba ?? new Uint8Array(0)
      // Wrap the transferred RGBA buffer as an ImageData. `Uint8ClampedArray`
      // shares storage with Uint8Array when constructed over its buffer.
      const imageData = new ImageData(
        new Uint8ClampedArray(rg),
        width,
        height
      )
      const payloads: Uint8Array[] = []
      if (roiGrid && roiGrid.cols > 1 && roiGrid.rows > 1) {
        // ROI decode: split the frame into a cols×rows grid and decode each cell
        // independently. Each cell is a small image, so zxing is much faster per
        // cell than scanning the whole frame — this is what unlocks 4-code
        // throughput on a phone. One code per cell (sender tiles 2×2).
        const cw = Math.ceil(width / roiGrid.cols)
        const ch = Math.ceil(height / roiGrid.rows)
        for (let r = 0; r < roiGrid.rows; r++) {
          for (let c = 0; c < roiGrid.cols; c++) {
            const x = c * cw
            const y = r * ch
            const w = Math.min(cw, width - x)
            const h = Math.min(ch, height - y)
            if (w <= 0 || h <= 0) continue
            const cell = cropRgba(rg, width, x, y, w, h)
            const cellImg = new ImageData(cell, w, h)
            const res = await zxing.readBarcodesFromImageData(cellImg, {
              formats: ["QRCode"],
              tryHarder: true,
              tryInvert: false,
              // One code per cell; allow 2 to survive a code straddling a seam.
              maxNumberOfSymbols: 2,
            })
            for (const r2 of res) {
              if (r2.bytes && r2.bytes.length >= 64) payloads.push(r2.bytes)
            }
          }
        }
      } else {
        // Two-tier decode: first a FAST pass (no tryHarder, no tryInvert), which
        // is several× faster on a clean frame; if it yields nothing, retry with
        // tryHarder (exhaustive) to catch a blurry/partial/mirrored code. We never
        // enable tryInvert — AirFerry only ever shows white-on-black-dark module
        // codes, so the inverted scan is pure wasted time (~2× slower).
        // NOTE: no adaptive ROI — Android's ROI tracking proved unreliable in
        // field testing and was reverted; whole-frame decode is the robust path.
        const opts = {
          formats: ["QRCode"] as const,
          maxNumberOfSymbols: 4,
          tryInvert: false,
        }
        let results = await zxing.readBarcodesFromImageData(imageData, {
          ...opts,
          tryHarder: false,
        })
        if (results.length === 0) {
          results = await zxing.readBarcodesFromImageData(imageData, {
            ...opts,
            tryHarder: true,
          })
        }
        for (const r of results) {
          if (r.bytes && r.bytes.length >= 64) {
            // Each QR payload is one AirFerry frame (header 60B + payload + 4B).
            // Minimum sanity: must clear the 64B floor. Full CRC check happens in
            // the Rust receiver (Frame::from_bytes).
            payloads.push(r.bytes)
          }
        }
      }
      post({ type: "decoded", payloads, jobId })
    } catch (err) {
      post({
        type: "error",
        message: `解码失败: ${String(err)}`,
        jobId,
      })
    }
    return
  }
})
