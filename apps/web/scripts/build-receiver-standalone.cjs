/**
 * Post-build: inline the Vite standalone-receiver output into a single
 * self-contained `index.html` that runs when double-clicked under `file://`.
 *
 * Input  (dist-receiver-standalone/):
 *   index.js                          — IIFE main bundle (receiver UI)
 *   *.css                             — styles
 *   assets/receive.worker-*.js        — receive worker chunk
 *   assets/qr-decode.worker-*.js      — QR decode worker chunk
 *   wasm-zstd.wasm                    — zstd decompress
 *   zxing_reader.wasm                 — zxing-wasm compat backend
 *   airferry_zxing.js/.wasm           — FAST ZXing-C++ backend (optional)
 *
 * Output (dist-receiver-standalone/index.html):
 *   One HTML file with:
 *     globalThis.__AIRFERRY_STANDALONE__   = true
 *     globalThis.__RECEIVE_WORKER_CODE__   = "<receive worker + prelude>"
 *     globalThis.__QR_WORKER_CODE__        = "<qr worker + prelude>"
 *     globalThis.__WASM_ZSTD__             = "<base64>"
 *   The two worker strings already carry their own base64 WASM constants:
 *     receive: __WASM_TRANSFER_ENGINE__
 *     qr:      __ZXING_FAST_JS__ / __ZXING_FAST_WASM__ / __ZXING_READER_WASM__
 *
 * Worker loading: ReceivePage starts these strings as module Blob workers.
 * Chromium treats file:// as a secure context and allows module Blob workers
 * there; the workers never fetch a sibling file.
 */
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const outDir = path.join(root, "dist-receiver-standalone")
const assetsDir = path.join(outDir, "assets")

function fail(message) {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

function findOne(dir, pattern, label) {
  const name = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((entry) => pattern.test(entry))
    : undefined
  if (!name) fail(`Missing ${label} in ${path.relative(root, dir)}`)
  return path.join(dir, name)
}

const mainJs = path.join(outDir, "index.js")
if (!fs.existsSync(mainJs)) {
  fail('Missing dist-receiver-standalone/index.js — run "vite build --config vite.receiver-standalone.config.ts" first.')
}
const cssFile = findOne(outDir, /\.css$/, "main CSS")
const receiveWorker = findOne(assetsDir, /^receive\.worker-.*\.js$/, "receive worker chunk")
const qrWorker = findOne(assetsDir, /^qr-decode\.worker-.*\.js$/, "QR worker chunk")

const zstdWasm = path.join(outDir, "wasm-zstd.wasm")
if (!fs.existsSync(zstdWasm)) {
  fail("Missing wasm-zstd.wasm — prepare-wasm.cjs should copy it from @foxglove/wasm-zstd.")
}
const transferWasm = path.join(root, "wasm-pkg", "transfer_engine_bg.wasm")
if (!fs.existsSync(transferWasm)) {
  fail("Missing apps/web/wasm-pkg/transfer_engine_bg.wasm — run prepare-wasm.cjs first.")
}

const readerWasm = path.join(outDir, "zxing_reader.wasm")
const fastJs = path.join(outDir, "airferry_zxing.js")
const fastWasm = path.join(outDir, "airferry_zxing.wasm")
const favicon = path.join(outDir, "favicon-receiver.png")

const receiveRaw = fs.readFileSync(receiveWorker, "utf8")
const qrRaw = fs.readFileSync(qrWorker, "utf8")

/** A static import cannot be resolved from a Blob worker under file://. */
function assertSelfContained(label, code) {
  const match = code.match(/^\s*import\s+(?:[\w*{}$]|["'])/m)
  if (match) {
    fail(
      `${label} worker chunk contains a static import (${match[0].trim()}); ` +
        "the standalone build cannot inline it. Check vite worker bundling."
    )
  }
}
assertSelfContained("receive", receiveRaw)
assertSelfContained("qr-decode", qrRaw)

const b64 = (file) => fs.readFileSync(file).toString("base64")

const fastJsSrc = fs.existsSync(fastJs) ? fs.readFileSync(fastJs, "utf8") : ""
const fastWasmB64 = fs.existsSync(fastWasm) ? b64(fastWasm) : ""
const readerB64 = fs.existsSync(readerWasm) ? b64(readerWasm) : ""
if (!fastJsSrc && !readerB64) {
  fail(
    "No QR backend available: need airferry_zxing.js/.wasm (FAST) or " +
      "zxing_reader.wasm (compat). Run scripts/build-fastzxing.sh or npm install."
  )
}

// The worker preludes are evaluated before the bundled worker module code.
const receiveCode = [
  "globalThis.__AIRFERRY_STANDALONE__=true;",
  `globalThis.__WASM_TRANSFER_ENGINE__=${JSON.stringify(b64(transferWasm))};`,
  receiveRaw,
].join("\n")

const qrCode = [
  "globalThis.__AIRFERRY_STANDALONE__=true;",
  `globalThis.__ZXING_FAST_JS__=${JSON.stringify(fastJsSrc)};`,
  `globalThis.__ZXING_FAST_WASM__=${JSON.stringify(fastWasmB64)};`,
  `globalThis.__ZXING_READER_WASM__=${JSON.stringify(readerB64)};`,
  qrRaw,
].join("\n")

const mainJsCode = fs.readFileSync(mainJs, "utf8")
const cssCode = fs.readFileSync(cssFile, "utf8")
const zstdB64 = b64(zstdWasm)

function escapeForInlineScript(code) {
  return code.replace(/<\/script>/gi, "<\\/script>").replace(/<!--/g, "<\\!--")
}

const prelude = [
  // Keep bundled deps that reference process.env from throwing under file://.
  `globalThis.process=globalThis.process||{env:{NODE_ENV:"production"}};`,
  `globalThis.__AIRFERRY_STANDALONE__=true;`,
  `globalThis.__RECEIVE_WORKER_CODE__=${JSON.stringify(receiveCode)};`,
  `globalThis.__QR_WORKER_CODE__=${JSON.stringify(qrCode)};`,
  `globalThis.__WASM_ZSTD__=${JSON.stringify(zstdB64)};`,
].join("\n")

const faviconTag = fs.existsSync(favicon)
  ? `<link rel="icon" type="image/png" href="data:image/png;base64,${b64(favicon)}">`
  : ""

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="description" content="用摄像头或屏幕捕获扫描 AirFerry 二维码视频流，无网接收文件。单文件版，双击即可运行（Chrome / Edge）。">
${faviconTag}
<title>AirFerry 接收端 · 单文件版</title>
<style>
${cssCode}
</style>
</head>
<body>
<div id="root"></div>
<script>
${escapeForInlineScript(prelude)}
${escapeForInlineScript(mainJsCode)}
</script>
</body>
</html>
`

// Remove intermediates before writing the single deliverable.
for (const file of [
  mainJs,
  cssFile,
  zstdWasm,
  readerWasm,
  fastJs,
  fastWasm,
  favicon,
]) {
  try {
    fs.unlinkSync(file)
  } catch {
    /* already absent */
  }
}
try {
  fs.rmSync(assetsDir, { recursive: true, force: true })
} catch {
  /* already absent */
}

const outHtml = path.join(outDir, "index.html")
fs.writeFileSync(outHtml, html)

const kb = (bytes) => (bytes / 1024).toFixed(0)
console.log("\n✓ Receiver standalone single-file HTML written:")
console.log(`    ${path.relative(root, outHtml)}  (${kb(fs.statSync(outHtml).size)} KB)`)
console.log(
  `    inlined: receive worker (${kb(receiveCode.length)} KB), ` +
    `QR worker (${kb(qrCode.length)} KB), zstd (${kb(zstdB64.length)} KB base64)`
)
console.log(
  `    QR backend: ${fastJsSrc ? "FAST ZXing-C++" : "zxing-wasm compat"}` +
    `${fastJsSrc ? ` (${kb(fastWasmB64.length)} KB wasm base64)` : ""}`
)
console.log(`    cleaned ${path.relative(root, outDir)} intermediates\n`)
