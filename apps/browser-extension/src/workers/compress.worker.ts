/**
 * File-preparation worker.
 *
 * Moves the heavy, synchronous-WASM file-prep pipeline (bundle build →
 * three-algorithm compression → CRC32 → content fingerprint → session-id
 * derivation) OFF the main thread, so the UI stays responsive while the sender
 * processes the chosen file(s). Without this, the zstd/lzma WASM compressors
 * block the main thread for seconds (level-22 zstd / level-9 xz on a few MB),
 * freezing all rendering — including any "compressing…" spinner — so the page
 * looks frozen. In a dedicated worker the main thread is free to paint a
 * progress overlay throughout.
 *
 * Bundled by Parcel 2 via `new Worker(new URL("./compress.worker.ts", import.meta.url),`
 * `{ type: "module" })` in options.tsx — one worker bundle is emitted per build
 * target (chrome-mv2/mv3, firefox-mv2/mv3). The CSP already permits worker
 * scripts + WASM (`'self'` + `wasm-unsafe-eval`/`wasm-eval`), and
 * `chrome.runtime.getURL` + `fetch` are available inside a dedicated worker
 * spawned by an extension page, so the existing zstd/lzma loaders work
 * unchanged.
 *
 * ## Message protocol
 *
 * In (from main):
 *   { files: File[] }                 — chosen files (File is structurally
 *                                       cloneable, so name/mtime/size travel
 *                                       with the buffer automatically)
 *
 * Out — progress (stage-based; the compressors are synchronous WASM so no
 * mid-stage percentage is possible, only phase boundaries):
 *   { phase: "reading" | "bundling" | "zstd" | "xz" }
 *
 * Out — final result:
 *   { phase: "done",
 *     compressed: ArrayBuffer,          — transferable (zero-copy back to main)
 *     algorithm, originalSize, compressedSize,
 *     preCrc32,                         — CRC32 of the pre-compression bytes
 *     sessionId: { lo: string, hi: string },  — 128-bit session id (as decimal
 *                                        strings; bigint survives structured
 *                                        clone but plain strings are simplest)
 *     displayName }
 *
 * Out — error:
 *   { phase: "error", message: string }
 */

/// <reference lib="webworker" />

import { preparePayload, initZstdFromBytes } from "@/wasm/compress"
import { crc32 } from "@/wasm/crc32"
import { contentFingerprint, deriveSessionId } from "@/wasm/session"
import { buildBundle } from "@/wasm/bundle"

/** Decimal-string form of the 128-bit session id, clone-safe across threads. */
export interface SessionIdDto {
  lo: string
  hi: string
}

/** Result message payload (phase = "done"). */
export interface CompressResult {
  phase: "done"
  /** Compressed payload, transferred back (detached from this thread). */
  compressed: ArrayBuffer
  algorithm: number
  originalSize: number
  compressedSize: number
  preCrc32: number
  sessionId: SessionIdDto
  displayName: string
}

export type CompressPhase = "reading" | "bundling" | "zstd" | "xz" | "finalizing"

/** All messages the worker posts back to the main thread. */
export type WorkerMessage =
  | { phase: CompressPhase }
  | CompressResult
  | { phase: "error"; message: string }

/** Queue of pending file compression requests, processed after WASM init. */
let pendingRequest: { files: File[] } | null = null
/** Whether the WASM module has been initialized. */
let wasmReady = false

self.onmessage = async (e: MessageEvent<{ files: File[] } | { type: "wasm-init"; zstd: ArrayBuffer }>) => {
  const data = e.data

  // Handle WASM pre-load message (sent from main thread before compression).
  if ("type" in data && data.type === "wasm-init") {
    initZstdFromBytes((data as { type: "wasm-init"; zstd: ArrayBuffer }).zstd)
    wasmReady = true
    // Process any pending request that arrived before WASM was ready
    if (pendingRequest) {
      const req = pendingRequest
      pendingRequest = null
      processFiles(req.files)
    }
    return
  }

  const { files } = data as { files: File[] }
  if (!files || files.length === 0) {
    post({ phase: "error", message: "no files" })
    return
  }

  // If WASM hasn't been initialized yet, queue this request
  if (!wasmReady) {
    pendingRequest = { files }
    return
  }

  processFiles(files)
}

async function processFiles(files: File[]) {

  try {
    // --- Stage 1: read files ---
    post({ phase: "reading" })
    const isBundle = files.length > 1
    let raw: Uint8Array
    let displayName: string
    if (isBundle) {
      post({ phase: "bundling" })
      const built = await buildBundle(files)
      raw = built.bytes
      displayName = `${files.length}个文件打包`
      console.log(`Bundle: ${files.length} files, ${raw.length} bytes pre-compress`)
    } else {
      raw = new Uint8Array(await files[0].arrayBuffer())
      displayName = files[0].name
    }

    // --- Stage 2: compress (zstd always; xz if compressible) ---
    // preparePayload drives the stage callback so we can post zstd/xz phase
    // boundaries up to the UI. The compress itself is synchronous WASM but
    // runs here in the worker, so the main thread keeps painting meanwhile.
    const { payload: compressed, algorithm, compressedSize } = await preparePayload(
      raw,
      (phase) => post({ phase })
    )
    console.log(
      `Compression: ${raw.length} → ${compressedSize} bytes ` +
        `(${raw.length > 0 ? ((compressedSize / raw.length) * 100).toFixed(1) : "0"}%)`
    )

    // --- Stage 3: CRC32 + fingerprint + session id (on the pre-compress bytes) ---
    // 这一段（CRC32 over the whole payload + head/tail fingerprint + session-id
    // 派生）没有任何阶段回调，是 done 前的"盲区"。大文件 CRC + 指纹可达
    // 数百毫秒，补一个 finalizing 阶段让 UI 步骤清单能显示它，而非从"压缩"
    // 直接跳到"完成"。
    post({ phase: "finalizing" })
    const crc = crc32(raw)
    const head = raw.slice(0, 1024)
    const tail = raw.slice(Math.max(0, raw.length - 1024))
    const fp = contentFingerprint(head, tail)

    let sessionId: { lo: bigint; hi: bigint }
    if (isBundle) {
      const mtimeMax = files.reduce(
        (m, f) => (f.lastModified > m ? f.lastModified : m),
        0
      )
      const namesJoined = files.map((f) => f.name).join("\u0001")
      sessionId = deriveSessionId(namesJoined, BigInt(raw.length), BigInt(mtimeMax), fp)
    } else {
      const f = files[0]
      sessionId = deriveSessionId(f.name, BigInt(f.size), BigInt(f.lastModified), fp)
    }

    // Transfer the compressed buffer back (zero-copy). Ensure it owns a
    // dedicated ArrayBuffer at offset 0 so the transfer detaches cleanly. The
    // compress output is always backed by a plain ArrayBuffer (zstd .slice()
    // or the original File bytes), never a SharedArrayBuffer, so the assert is
    // safe.
    const ownsBuffer =
      compressed.byteOffset === 0 && compressed.byteLength === compressed.buffer.byteLength
    const outBuf = (ownsBuffer ? compressed.buffer : compressed.slice().buffer) as ArrayBuffer

    const result: CompressResult = {
      phase: "done",
      compressed: outBuf,
      algorithm,
      originalSize: raw.length,
      compressedSize,
      preCrc32: crc,
      sessionId: {
        lo: sessionId.lo.toString(),
        hi: sessionId.hi.toString(),
      },
      displayName,
    }
    // Detach the ArrayBuffer via the transfer list.
    ;(self as unknown as Worker).postMessage(result, [outBuf])
  } catch (err) {
    post({ phase: "error", message: (err as Error)?.message || String(err) })
  }
}

/** Post a non-transferable message. */
function post(msg: WorkerMessage): void {
  ;(self as unknown as Worker).postMessage(msg)
}
