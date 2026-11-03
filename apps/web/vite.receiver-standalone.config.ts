/**
 * Vite config for the single-file (standalone) web receiver.
 *
 * Mirrors vite.receiver.config.ts but produces an IIFE main bundle plus two
 * worker chunks in dist-receiver-standalone/; scripts/build-receiver-standalone.cjs
 * then inlines everything into one index.html that runs from `file://`.
 *
 * Why IIFE: `file://` blocks external module scripts. Why module Blob workers:
 * the worker chunks contain `import.meta.url` and dynamic-import machinery, and
 * Chromium permits module Blob workers under `file://` (verified with Chrome).
 * The post-processor injects the WASM bytes as base64 so no worker fetches a
 * sibling `.wasm` file.
 */
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@/", replacement: path.resolve(__dirname, "../sender/src/") + "/" },
      { find: "@airferry-wasm/", replacement: path.resolve(__dirname, "wasm-pkg/") + "/" },
      // zxing-wasm + lzma-wasm live in web's node_modules; the QR/receive
      // workers are compiled from sender source, so pin the exact dist entry.
      {
        find: "zxing-wasm/reader",
        replacement: path.resolve(
          __dirname,
          "node_modules/zxing-wasm/dist/es/reader/index.js"
        ),
      },
      {
        find: /^zxing-wasm$/,
        replacement: path.resolve(
          __dirname,
          "node_modules/zxing-wasm/dist/es/full/index.js"
        ),
      },
      {
        find: "lzma-wasm",
        replacement: path.resolve(__dirname, "node_modules/lzma-wasm"),
      },
    ],
  },
  optimizeDeps: {
    exclude: ["lzma-wasm", "@foxglove/wasm-zstd"],
  },
  worker: {
    format: "es",
    // Each worker is inlined as one script. A shared chunk import would be
    // unresolvable from a Blob worker under file://.
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  build: {
    outDir: "dist-receiver-standalone",
    emptyOutDir: true,
    // IIFE + inlineDynamicImports: one classic script for file://; worker
    // chunks are still emitted separately for the post-processor.
    lib: {
      entry: path.resolve(__dirname, "src/receiver-standalone.tsx"),
      formats: ["iife"],
      name: "AirFerryReceiverStandalone",
      fileName: () => "index.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    assetsInlineLimit: 100 * 1024, // inline CSS/icons; keep WASM as files
    target: "esnext",
    cssCodeSplit: false,
  },
  base: "./",
})
