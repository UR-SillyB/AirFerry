/**
 * Prepare WASM assets for the web builds.
 *
 *  1. `apps/web/wasm-pkg/` — the single scalar Rust WASM produced by
 *     `wasm-pack` (wasm-bindgen 0.2.92, Chrome 87 → current).
 *
 *  2. FAST ZXing-C++ backend (`airferry_zxing.js` + `.wasm`) into `public/`
 *     for the QR decode worker (FAST-only receiver).
 *
 * Run via `predev`/`prebuild`. Idempotent.
 */
const fs = require("fs")
const path = require("path")

const webRoot = path.resolve(__dirname, "..")
const wasmPkgDir = path.join(webRoot, "wasm-pkg")
const wasmPkgGlue = path.join(wasmPkgDir, "transfer_engine.js")
const wasmPkgBinary = path.join(wasmPkgDir, "transfer_engine_bg.wasm")

if (!fs.existsSync(wasmPkgGlue) || !fs.existsSync(wasmPkgBinary)) {
  console.error(
    "\n✖ wasm-pkg/ is incomplete. Build it first with: " +
      "cd apps/web && npm install && npm run wasm\n"
  )
  process.exit(1)
}
console.log("[prepare-wasm] wasm-pkg verified")

const publicDir = path.join(webRoot, "public")
fs.mkdirSync(publicDir, { recursive: true })

// Copy the self-compiled FAST ZXing-C++ backend (airferry_zxing.js + .wasm)
// into public/ for the QR decode worker. Produced by scripts/build-fastzxing.sh.
const fastzxingDir = path.join(webRoot, "src", "fastzxing")
const fastFiles = ["airferry_zxing.js", "airferry_zxing.wasm"]
let fastCopied = false
const missingFast = []
for (const f of fastFiles) {
  const src = path.join(fastzxingDir, f)
  const dst = path.join(publicDir, f)
  if (fs.existsSync(src)) {
    const need =
      !fs.existsSync(dst) ||
      fs.statSync(dst).size !== fs.statSync(src).size ||
      fs.statSync(dst).mtimeMs < fs.statSync(src).mtimeMs
    if (need) {
      fs.copyFileSync(src, dst)
      fastCopied = true
    }
  } else {
    missingFast.push(f)
  }
}
if (missingFast.length > 0) {
  console.error(
    `\n✖ FAST ZXing backend missing: ${missingFast.join(", ")}. ` +
      "The web receiver is FAST-only. " +
      "Run scripts/build-fastzxing.sh (requires Emscripten 3.1.64; artifacts are cached).\n"
  )
  process.exit(1)
}
if (fastCopied) {
  console.log("[prepare-wasm] copied airferry_zxing.js/.wasm → public/")
}

console.log("[prepare-wasm] ready")
