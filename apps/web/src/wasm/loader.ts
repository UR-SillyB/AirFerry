/**
 * Loader + thin wrapper around the Rust `transfer_engine` WASM module.
 *
 * `npm run wasm` produces the Rust package. The `@airferry-wasm` alias points
 * to the scalar WASM package in `wasm-pkg/`. It exposes `SenderBuilderWasm`
 * and `encode_qr`; initialization is lazy.
 *
 * Standalone (single-file) build: under `file://`, `fetch()` of the `.wasm`
 * asset is blocked, so the standalone build inlines the WASM as a base64
 * constant on `globalThis.__WASM_TRANSFER_ENGINE__`. When present we decode it
 * and pass the buffer directly to `init(buffer)` — the wasm-bindgen glue routes
 * any non-string/URL/Request input straight to `WebAssembly.instantiate(buffer)`,
 * bypassing fetch entirely.
 *
 * Integrity pin: before instantiation, the bytes (fetched or inlined) must
 * SHA-256 to `__WASM_TRANSFER_ENGINE_SHA256__`, which the Vite configs inject
 * from `scripts/wasm-fingerprint.ts` at build time. This makes a swapped or
 * tampered wasm fail loudly instead of silently becoming the trust root of
 * both sender hashing and receiver verification. It does NOT protect against
 * a fully compromised build pipeline (see the fingerprint module docs). On
 * insecure origins where `crypto.subtle` is unavailable the check degrades to
 * a console warning rather than breaking the app.
 */
import init, {
  SenderBuilderWasm,
  SenderSessionWasm,
  ReceiverSessionWasm,
  Blake3Wasm,
  encode_qr,
  encode_chunk_balanced,
  plan_chunks,
} from "@airferry-wasm/transfer_engine.js"
import wasmUrl from "@airferry-wasm/transfer_engine_bg.wasm?url"
import { base64ToBuffer } from "./base64"

// Injected by the Vite `define` block (scripts/wasm-fingerprint.ts).
declare const __WASM_TRANSFER_ENGINE_SHA256__: string

function toHex(bytes: Uint8Array): string {
  let hex = ""
  for (const b of bytes) hex += b.toString(16).padStart(2, "0")
  return hex
}

/** Fetch (or decode) the wasm bytes and verify them against the build pin. */
async function verifiedWasmInput(): Promise<BufferSource> {
  const standaloneB64 =
    (globalThis as { __WASM_TRANSFER_ENGINE__?: string }).__WASM_TRANSFER_ENGINE__
  const buffer: ArrayBuffer = standaloneB64
    ? (base64ToBuffer(standaloneB64) ??
      (() => {
        throw new Error("standalone wasm payload is empty")
      })())
    : await (await fetch(wasmUrl)).arrayBuffer()
  const view = new Uint8Array(buffer)
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", view))
    const hex = toHex(digest)
    if (hex !== __WASM_TRANSFER_ENGINE_SHA256__) {
      throw new Error(
        `transfer_engine_bg.wasm 完整性校验失败：期望 ${__WASM_TRANSFER_ENGINE_SHA256__.slice(0, 12)}…，实际 ${hex.slice(0, 12)}…`
      )
    }
  } else {
    console.warn(
      "[airferry] crypto.subtle 不可用（非安全上下文），跳过 wasm 完整性校验"
    )
  }
  return view
}

let initPromise: Promise<void> | null = null

/** Initialize the WASM module exactly once. */
export function ensureWasm(): Promise<void> {
  if (!initPromise) {
    const pending = verifiedWasmInput()
      .then((input) => init(input))
      .then(() => undefined)
    let retryable: Promise<void>
    retryable = pending.catch((error: unknown) => {
      // A transient fetch/instantiation failure must not poison every later
      // retry for the lifetime of the page.
      if (initPromise === retryable) initPromise = null
      throw error
    })
    initPromise = retryable
  }
  return initPromise
}

export {
  SenderBuilderWasm,
  SenderSessionWasm,
  ReceiverSessionWasm,
  Blake3Wasm,
  encode_qr,
  encode_chunk_balanced,
  plan_chunks,
}
