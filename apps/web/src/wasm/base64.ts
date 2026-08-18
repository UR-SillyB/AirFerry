/**
 * Base64 → ArrayBuffer decoder, used by the single-file (standalone) web build.
 *
 * In the standalone build the WASM binaries are inlined as base64 string
 * constants (injected at build time by scripts/build-standalone.cjs) so the
 * page works under `file://` where `fetch()` of `.wasm` assets is blocked by
 * the browser's same-origin policy. At runtime we decode those constants back
 * into bytes and feed them to the same `WebAssembly.instantiate(buffer, ...)`
 * paths the normal fetch-based loaders use.
 *
 * Uses `atob` + manual byte copy (the classic, allocation-light pattern). Works
 * identically on the main thread and inside a Web Worker (`atob` is available
 * in both global scopes).
 */

/**
 * Decode a base64 string into a fresh `ArrayBuffer`. Returns `null` for falsy
 * input so callers can write `buf ? base64ToBuffer(buf) : undefined` without
 * branching on the standalone flag twice.
 */
export function base64ToBuffer(b64: string | undefined | null): ArrayBuffer | undefined {
  if (!b64) return undefined
  const bin = atob(b64)
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  // Return the underlying buffer (the WASM APIs take ArrayBuffer/TypedArray).
  return bytes.buffer
}
