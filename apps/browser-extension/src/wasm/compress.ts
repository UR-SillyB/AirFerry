/**
 * Compression helper for the browser sender.
 *
 * The browser cannot link the native `zstd` C library to wasm32-unknown-unknown,
 * so compression is performed in JS only when a compress-capable zstd-wasm
 * library is wired in. For v1 the sender passes data through UNCOMPRESSED —
 * the receiver reassembles raw bytes directly. Compression remains a future
 * optimization and is isolated behind this module so enabling it later is a
 * one-file change (swap `preparePayload` to call a zstd-compress lib).
 *
 * The `compressed` flag returned here is informational; a future protocol
 * revision can carry it in the session descriptor so the receiver knows whether
 * to decompress.
 */

/** Whether the sender compresses payload before encoding. */
export const COMPRESSION_ENABLED = false

/**
 * Compress (or pass-through). Returns the payload bytes plus a flag indicating
 * whether compression was actually applied.
 */
export function preparePayload(data: Uint8Array): {
  payload: Uint8Array
  compressed: boolean
} {
  if (!COMPRESSION_ENABLED) {
    return { payload: data, compressed: false }
  }
  // When a compress-capable zstd JS lib is wired in, compress here and return
  // { payload: zstdCompress(data), compressed: true }.
  return { payload: data, compressed: false }
}
