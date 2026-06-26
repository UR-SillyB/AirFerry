/**
 * File-preparation worker.
 *
 * Moves the heavy, synchronous-WASM file-prep pipeline (bundle build →
 * three-algorithm compression → CRC32 → content fingerprint → session-id
 * derivation) OFF the main thread, so the UI stays responsive while the sender
 * processes the chosen file(s). Without this, the zstd/lzma WASM compressors
 * block the main thread for seconds (level-1 zstd / level-9 xz on a few MB),
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
 *   { text: string }                  — chosen text (text Tab). Wrapped in the
 *                                       ETTEXTv1 magic and processed exactly
 *                                       like a single file's bytes.
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
import { buildTextPayload, TEXT_DISPLAY_NAME } from "@/wasm/text"

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

/** Queue of pending compression requests, processed after WASM init. */
let pendingFiles: File[] | null = null
let pendingText: string | null = null
/** Whether the WASM module has been initialized. */
let wasmReady = false

self.onmessage = async (e: MessageEvent<{ files: File[] } | { text: string } | { type: "wasm-init"; zstd: ArrayBuffer }>) => {
  const data = e.data

  // Handle WASM pre-load message (sent from main thread before compression).
  if ("type" in data && data.type === "wasm-init") {
    initZstdFromBytes((data as { type: "wasm-init"; zstd: ArrayBuffer }).zstd)
    wasmReady = true
    // Process whatever request arrived first while WASM was loading.
    if (pendingFiles) {
      const req = pendingFiles
      pendingFiles = null
      processFiles(req)
    } else if (pendingText !== null) {
      const req = pendingText
      pendingText = null
      processText(req)
    }
    return
  }

  if ("text" in data) {
    // Text Tab input.
    if (data.text.length === 0) {
      post({ phase: "error", message: "empty text" })
      return
    }
    if (!wasmReady) {
      pendingText = data.text
      return
    }
    processText(data.text)
    return
  }

  const { files } = data as { files: File[] }
  if (!files || files.length === 0) {
    post({ phase: "error", message: "no files" })
    return
  }

  // If WASM hasn't been initialized yet, queue this request
  if (!wasmReady) {
    pendingFiles = files
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
    let sessionId: { lo: bigint; hi: bigint }
    if (isBundle) {
      post({ phase: "bundling" })
      const built = await buildBundle(files)
      raw = built.bytes
      displayName = `${files.length}个文件打包`
      console.log(`Bundle: ${files.length} files, ${raw.length} bytes pre-compress`)
      const fp = computeFingerprint(raw)
      const mtimeMax = files.reduce(
        (m, f) => (f.lastModified > m ? f.lastModified : m),
        0
      )
      const namesJoined = files.map((f) => f.name).join("\u0001")
      sessionId = deriveSessionId(namesJoined, BigInt(raw.length), BigInt(mtimeMax), fp)
    } else {
      raw = new Uint8Array(await files[0].arrayBuffer())
      displayName = files[0].name
      const fp = computeFingerprint(raw)
      const f = files[0]
      sessionId = deriveSessionId(f.name, BigInt(f.size), BigInt(f.lastModified), fp)
    }

    await finalizeAndPost(raw, displayName, sessionId)
  } catch (err) {
    post({ phase: "error", message: (err as Error)?.message || String(err) })
  }
}

/**
 * Process a text transfer: wrap the text in the ETTEXTv1 magic, then feed the
 * bytes through the SAME compress → CRC → finalize path as a file. The session
 * id is derived from a fixed name ("文字消息.txt"), the payload size, the
 * current timestamp (standing in for a file's mtime), and the content
 * fingerprint — so the same text sent twice in quick succession still gets a
 * distinct id (the timestamp differs), but resuming a broken transfer of the
 * same text seconds later re-derives the same id deterministically.
 */
async function processText(text: string) {
  try {
    post({ phase: "reading" })
    const raw = buildTextPayload(text)
    const fp = computeFingerprint(raw)
    // mtime substitute: Date.now() at send time. Deterministic enough for
    // resume within the same moment; differs across distinct sends.
    const sessionId = deriveSessionId(
      TEXT_DISPLAY_NAME,
      BigInt(raw.length),
      BigInt(Date.now()),
      fp
    )
    await finalizeAndPost(raw, TEXT_DISPLAY_NAME, sessionId)
  } catch (err) {
    post({ phase: "error", message: (err as Error)?.message || String(err) })
  }
}

/**
 * Shared finalize tail for both file and text paths: compress → CRC32 +
 * fingerprint already done by caller → package the transferable result and
 * post `done`. Runs the heavy synchronous-WASM compress here in the worker so
 * the main thread keeps painting the progress overlay.
 */
async function finalizeAndPost(
  raw: Uint8Array,
  displayName: string,
  sessionId: { lo: bigint; hi: bigint }
) {
  // --- Compress (zstd always; xz if compressible) ---
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

  // --- CRC32 (on the pre-compress bytes) ---
  // 这一段（CRC32 over the whole payload）没有任何阶段回调，是 done 前的"盲区"。
  // 大文件 CRC 可达数百毫秒，补一个 finalizing 阶段让 UI 步骤清单能显示它，
  // 而非从"压缩"直接跳到"完成"。
  post({ phase: "finalizing" })
  const crc = crc32(raw)

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
}

/**
 * Content fingerprint over the head + tail of the pre-compress bytes. Mirrors
 * the Rust `SessionId::content_fingerprint` so both ends derive the same
 * session id. Wrapped in a helper so the file and text paths stay in sync.
 */
function computeFingerprint(raw: Uint8Array): Uint8Array {
  const head = raw.slice(0, 1024)
  const tail = raw.slice(Math.max(0, raw.length - 1024))
  return contentFingerprint(head, tail)
}

/** Post a non-transferable message. */
function post(msg: WorkerMessage): void {
  ;(self as unknown as Worker).postMessage(msg)
}
