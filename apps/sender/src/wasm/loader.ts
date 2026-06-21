/**
 * Loader + thin wrapper around the Rust `transfer_engine` WASM module.
 *
 * The WASM pkg is produced by `pnpm wasm` (wasm-pack) into `../wasm-pkg/`. It
 * exposes `SenderSessionWasm` and `encode_qr`. We lazily initialize the module
 * on first use. The wasm-bindgen glue resolves the `.wasm` asset URL relative
 * to its own `import.meta.url`, which Vite/Plasmo bundles correctly.
 */
import init, { SenderSessionWasm, encode_qr } from "../../wasm-pkg/transfer_engine.js"

let initPromise: Promise<void> | null = null

/** Initialize the WASM module exactly once. */
export function ensureWasm(): Promise<void> {
  if (!initPromise) {
    // The glue derives the wasm URL from import.meta.url when no arg is given.
    initPromise = init().then(() => undefined)
  }
  return initPromise
}

export { SenderSessionWasm, encode_qr }
