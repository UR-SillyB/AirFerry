/**
 * Extract the base64-inlined WASM from lzma-wasm's ESM bundle into a physical
 * `.wasm` file, so Vite/Rollup can resolve the `new URL("lzma_wasm_bg.wasm",
 * import.meta.url)` expression at build time.
 *
 * lzma-wasm@1.x inlines its WASM as base64 AND keeps the `new URL(...)` fallback.
 * At runtime only the base64 path runs, but Rollup statically analyzes the URL
 * at build time and fails because the file isn't shipped. This script decodes
 * the base64 and writes it to the path Rollup expects.
 *
 * Identical to the sender's extract-lzma-wasm.cjs (operates on this project's
 * own node_modules). Run via `postinstall` and before every build. Idempotent.
 */
const fs = require("fs")
const path = require("path")

const esmDir = path.join(__dirname, "..", "node_modules", "lzma-wasm", "dist", "esm")
const jsPath = path.join(esmDir, "index.js")
const wasmOut = path.join(esmDir, "lzma_wasm_bg.wasm")

if (!fs.existsSync(jsPath)) {
  // Package not installed yet (e.g. fresh clone before npm install) — skip.
  process.exit(0)
}

const code = fs.readFileSync(jsPath, "utf8")
const m = code.match(/var h="([A-Za-z0-9+/=]+)"/)
if (!m) {
  console.warn("[extract-lzma-wasm] base64 WASM not found in lzma-wasm ESM bundle — skipping")
  process.exit(0)
}

const wasm = Buffer.from(m[1], "base64")
if (wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) {
  console.warn("[extract-lzma-wasm] decoded bytes are not a valid WASM module — skipping")
  process.exit(0)
}

// Skip if already up to date.
const existing = fs.existsSync(wasmOut) ? fs.statSync(wasmOut).size : -1
if (existing === wasm.length) {
  process.exit(0)
}

fs.writeFileSync(wasmOut, wasm)
console.log(`[extract-lzma-wasm] wrote ${wasm.length} bytes to ${path.relative(process.cwd(), wasmOut)}`)
