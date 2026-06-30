/**
 * Post-build: inline the Vite standalone output into a single self-contained
 * `index.html` that runs when double-clicked under `file://`.
 *
 * Input  (dist-standalone/):
 *   index.js                       — IIFE main bundle (transfer_engine WASM
 *                                    already inlined as base64 by Vite)
 *   web.css                        — styles
 *   assets/compress.worker-*.js    — worker chunk (lzma WASM already inlined,
 *                                    fully self-contained, no external imports)
 *   wasm-zstd.wasm                 — zstd WASM (kept as a file; we base64 it)
 *
 * Output (dist-standalone/index.html):
 *   A single HTML file. Before the main bundle runs, three globals are defined
 *   so the shared sender source picks the file://-safe code paths:
 *     globalThis.__AIRFERRY_STANDALONE__ = true   (gate flag)
 *     globalThis.__WORKER_CODE__          = "..."  (worker source as a string;
 *                                          options.tsx wraps it in a Blob URL)
 *     globalThis.__WASM_ZSTD__            = "..."  (zstd WASM as base64;
 *                                          main thread decodes + posts to worker)
 *   transfer_engine WASM is already inlined inside index.js (Vite did it), so
 *   loader.ts reads it via the same base64 constant mechanism only if present —
 *   here it is NOT a global, it's baked into the bundle. lzma WASM is likewise
 *   already inlined inside the worker chunk.
 *
 * Quoting: the worker source and WASM base64 are wrapped in a JSON.stringify'd
 * string literal inside a `var` declaration — safe against any content (quotes,
 * newlines, </script> sequences are all escaped by JSON).
 */
const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const outDir = path.join(root, "dist-standalone")

// Locate the intermediate artifacts Vite produced.
const mainJs = path.join(outDir, "index.js")
const cssFile = path.join(outDir, "web.css")
const zstdWasm = path.join(outDir, "wasm-zstd.wasm")

for (const f of [mainJs, cssFile, zstdWasm]) {
  if (!fs.existsSync(f)) {
    console.error(`\n✖ Missing build artifact: ${path.relative(root, f)}\n  Run "vite build --config vite.standalone.config.ts" first.\n`)
    process.exit(1)
  }
}

// The worker chunk has a content-hashed name (e.g. compress.worker-BcBCKaY9.js).
const assetsDir = path.join(outDir, "assets")
const workerFile = fs.readdirSync(assetsDir).find((n) => /^compress\.worker-.*\.js$/.test(n))
if (!workerFile) {
  console.error(`\n✖ Missing worker chunk in ${path.relative(root, assetsDir)}\n`)
  process.exit(1)
}
const workerPath = path.join(assetsDir, workerFile)

const mainJsCode = fs.readFileSync(mainJs, "utf8")
const cssCode = fs.readFileSync(cssFile, "utf8")
// The worker chunk is ES-formatted and contains `import.meta.url` inside the
// lzma-wasm wasm-bindgen glue's fetch-fallback path. Under file:// we load the
// worker from a Blob URL as a CLASSIC worker (best cross-browser support), so
// `import.meta` would throw a SyntaxError at parse time — even though that code
// path (the fetch fallback) is never reached at runtime (lzma self-decodes its
// base64). Replace the expression with a benign string literal so the worker
// parses as classic script. The fallback path is dead in the standalone build
// anyway (no fetch possible under file://).
const workerCodeRaw = fs.readFileSync(workerPath, "utf8").replace(
  /import\.meta\.url/g,
  '"blob:standalone"'
)
const zstdB64 = fs.readFileSync(zstdWasm).toString("base64")

/**
 * Escape `</script>` sequences inside inlined JS so the HTML parser doesn't
 * prematurely close our `<script>` block. JSON.stringify does NOT escape this
 * (it only handles quotes/backslash/control chars), so we do it ourselves for
 * both the raw main bundle and the stringified constants. The replacement
 * `<\/script>` is identical to `</script>` once the JS string is parsed, but the
 * backslash hides the sequence from the HTML tokenizer. Also escape `<!--`
 * (the other sequence the HTML spec treats specially inside <script>).
 */
function safeForInlineScript(code) {
  return code.replace(/<\/script>/gi, "<\\/script>").replace(/<!--/g, "<\\!--")
}

// Prelude: define the globals the shared sender source reads. JSON.stringify
// guarantees the embedded strings survive intact regardless of their content
// (newlines, quotes, backslashes). The subsequent safeForInlineScript pass
// additionally neutralizes any `</script>` / `<!--` sequences inside the
// stringified values so the HTML parser keeps our script block open.
const prelude = [
  // Minimal `process` polyfill. Some bundled deps (prop-types, etc.) reference
  // `process.env.NODE_ENV` / `typeof process` directly rather than going
  // through Vite's define substitution, and `process` is undefined in a
  // browser under file://. Defining it before the bundle runs keeps those
  // checks from throwing. NODE_ENV="production" also trims dev-only code paths.
  `globalThis.process=globalThis.process||{env:{NODE_ENV:"production"}};`,
  `globalThis.__AIRFERRY_STANDALONE__=true;`,
  `globalThis.__WORKER_CODE__=${JSON.stringify(workerCodeRaw)};`,
  `globalThis.__WASM_ZSTD__=${JSON.stringify(zstdB64)};`,
].join("\n")

// Assemble the single-file HTML. Classic <script> (no type="module") so it
// runs under file://; the IIFE bundle has no imports/exports so this is fine.
// Escape </script> in BOTH the prelude and the main bundle (either can contain
// the sequence, e.g. inside a stringified worker source or template literals).
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="通过屏幕二维码视频流，无网传输文件到手机。单文件版，双击即可运行。">
<title>AirFerry · 无网文件传输</title>
<style>
${cssCode}
</style>
</head>
<body>
<div id="root"></div>
<script>
${safeForInlineScript(prelude)}
${safeForInlineScript(mainJsCode)}
</script>
</body>
</html>
`

const outHtml = path.join(outDir, "index.html")
fs.writeFileSync(outHtml, html)

// Report sizes.
const htmlKb = (fs.statSync(outHtml).size / 1024).toFixed(0)
const workerKb = (workerCodeRaw.length / 1024).toFixed(0)
const zstdKb = (zstdB64.length / 1024).toFixed(0)
console.log(`\n✓ Standalone single-file HTML written:`)
console.log(`    ${path.relative(root, outHtml)}  (${htmlKb} KB)`)
console.log(`    inlined: worker (${workerKb} KB), wasm-zstd (${zstdKb} KB base64)`)
console.log(`    transfer_engine + lzma WASM already inlined by Vite into the JS bundle.\n`)
