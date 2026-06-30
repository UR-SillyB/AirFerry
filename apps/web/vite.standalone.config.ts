/**
 * Vite config for the standalone (single-file) web build.
 *
 * Goal: one self-contained `index.html` that runs when double-clicked under
 * `file://` (no server). Three things that normally break under file:// are
 * handled here / by scripts/build-standalone.cjs:
 *
 *  1. `<script type="module">` is blocked under file:// → build the main bundle
 *     as an IIFE with `inlineDynamicImports` (no ESM, no chunk graph). The
 *     post-build script rewrites index.html to use a classic `<script>`.
 *  2. `new Worker(url)` can't load a separate file under file:// → emit the
 *     worker as its own ES chunk; the post-build script inlines it as a string
 *     and options.tsx spawns it from a Blob URL when `__AIRFERRY_STANDALONE__`.
 *  3. WASM `fetch(import.meta.url)` is blocked → the post-build script inlines
 *     the two fetchable WASM blobs (transfer_engine, wasm-zstd) as base64
 *     constants; lzma-wasm already self-inlines its wasm as base64.
 *
 * This config only produces the multi-file intermediate output (IIFE bundle +
 * separate worker chunk + WASM assets); build-standalone.cjs does the inlining.
 */
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  // Reuse the main config's HTML entry — Vite picks up standalone.html (its
  // <script> points at src/standalone.ts, which sets the standalone flag).
  build: {
    outDir: "dist-standalone",
    // IIFE so the inlined `<script>` is classic (no `type="module"`), which
    // file:// allows. `inlineDynamicImports` flattens the dynamic imports
    // (the worker URL + lazy chunks) into a single file — required because IIFE
    // can't emit multiple chunks.
    lib: {
      entry: path.resolve(__dirname, "src/standalone.tsx"),
      formats: ["iife"],
      name: "AirFerryStandalone",
      fileName: () => "index.js",
    },
    // Emit the worker as its own chunk (build-standalone.cjs inlines it as a
    // string). Without this, `inlineDynamicImports` would try to pull the
    // worker into the main IIFE, which breaks `new Worker`.
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    // Keep WASM as files (NOT inlined by Vite) — build-standalone.cjs reads
    // them and base64-inlines into the HTML. CSS + icons inline as base64.
    assetsInlineLimit: 100 * 1024, // inline assets < 100KB (CSS, icons); WASM is bigger
    target: "esnext",
    cssCodeSplit: false,
  },
  resolve: {
    alias: [
      // Same as the main web config: point @/ at the real sender source.
      { find: "@/", replacement: path.resolve(__dirname, "../sender/src/") + "/" },
    ],
  },
  worker: {
    // Worker as a separate ES chunk so it can be stringified + Blob-URL'd.
    format: "es",
  },
  optimizeDeps: {
    exclude: ["lzma-wasm"],
  },
})
