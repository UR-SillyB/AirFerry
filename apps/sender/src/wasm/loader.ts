/**
 * Loader + thin wrapper around the Rust `transfer_engine` WASM module.
 *
 * The WASM pkg is produced by `pnpm wasm` (wasm-pack) into `../wasm-pkg/`. It
 * exposes `SenderSessionWasm` and `encode_qr`. We lazily initialize the module
 * on first use. The wasm-bindgen glue resolves the `.wasm` asset URL relative
 * to its own `import.meta.url`, which Vite/Plasmo bundles correctly.
 *
 * Standalone (single-file) build: under `file://`, `fetch()` of the `.wasm`
 * asset is blocked, so the standalone build inlines the WASM as a base64
 * constant on `globalThis.__WASM_TRANSFER_ENGINE__`. When present we decode it
 * and pass the buffer directly to `init(buffer)` — the wasm-bindgen glue routes
 * any non-string/URL/Request input straight to `WebAssembly.instantiate(buffer)`,
 * bypassing fetch entirely.
 */
import init, { SenderSessionWasm, encode_qr } from "../../wasm-pkg/transfer_engine.js"
import { base64ToBuffer } from "./base64"

let initPromise: Promise<void> | null = null

/** Initialize the WASM module exactly once. */
export function ensureWasm(): Promise<void> {
  if (!initPromise) {
    // Standalone build inlines the wasm as base64 (file:// can't fetch it).
    // When absent (extension / normal web), pass nothing → the glue derives the
    // URL from import.meta.url and fetches normally.
    const standaloneB64 =
      (globalThis as { __WASM_TRANSFER_ENGINE__?: string }).__WASM_TRANSFER_ENGINE__
    initPromise = init(base64ToBuffer(standaloneB64)).then(() => undefined)
  }
  return initPromise
}

export { SenderSessionWasm, encode_qr }
