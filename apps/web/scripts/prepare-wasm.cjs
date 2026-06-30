/**
 * Prepare WASM assets for the web sender before dev/build.
 *
 * Two things must be in place:
 *
 *  1. `apps/sender/wasm-pkg/` — the Rust `transfer_engine` WASM produced by
 *     `wasm-pack`. The web app imports it (via loader.ts's relative path
 *     `../../wasm-pkg/transfer_engine.js`), so it MUST exist. It is a build
 *     artifact of the sender project (run `npm run wasm` there). We only check
 *     here — we never rebuild Rust from this project.
 *
 *  2. `public/wasm-zstd.wasm` — the zstd compressor WASM, fetched at runtime by
 *     the compress worker's fallback path (`new URL("wasm-zstd.wasm",
 *     self.location.href)`). In the extension this file lives next to the page;
 *     on the web it must be served from the site root, so we copy it into
 *     `public/` where Vite serves static assets.
 *
 * Run via `predev`/`prebuild`. Idempotent.
 */
const fs = require("fs")
const path = require("path")

const webRoot = path.resolve(__dirname, "..")
const senderRoot = path.resolve(webRoot, "..", "sender")
const wasmPkgDir = path.join(senderRoot, "wasm-pkg")
const wasmPkgGlue = path.join(wasmPkgDir, "transfer_engine.js")

// (1) Verify the sender's wasm-pkg exists.
if (!fs.existsSync(wasmPkgGlue)) {
  console.error(
    "\n✖ apps/sender/wasm-pkg/transfer_engine.js not found.\n" +
      "  The web app reuses the sender's Rust WASM. Build it first:\n" +
      "    cd apps/sender && npm install && npm run wasm\n" +
      "  (this runs wasm-pack for the transfer-engine crate)\n"
  )
  process.exit(1)
}

// (2) Copy wasm-zstd.wasm into public/ for the worker's runtime fetch.
const zstdSrc = path.join(webRoot, "node_modules", "@foxglove", "wasm-zstd", "dist", "wasm-zstd.wasm")
const publicDir = path.join(webRoot, "public")
const zstdDst = path.join(publicDir, "wasm-zstd.wasm")

if (!fs.existsSync(zstdSrc)) {
  console.error(
    "\n✖ @foxglove/wasm-zstd not installed. Run `npm install` in apps/web first.\n"
  )
  process.exit(1)
}

fs.mkdirSync(publicDir, { recursive: true })

// Skip copy if already up to date.
const needCopy =
  !fs.existsSync(zstdDst) ||
  fs.statSync(zstdDst).size !== fs.statSync(zstdSrc).size ||
  fs.statSync(zstdDst).mtimeMs < fs.statSync(zstdSrc).mtimeMs

if (needCopy) {
  fs.copyFileSync(zstdSrc, zstdDst)
  console.log(`[prepare-wasm] copied wasm-zstd.wasm → ${path.relative(webRoot, zstdDst)}`)
} else {
  console.log("[prepare-wasm] wasm-zstd.wasm up to date")
}

console.log("[prepare-wasm] ready")
