/**
 * Vite config for the AirFerry web sender.
 *
 * This project reuses the sender extension's source verbatim via cross-project
 * imports. Two cross-project concerns are handled here:
 *
 *  1. `@/` alias — the sender's source (e.g. types.ts, components/, wasm/)
 *     imports each other through `@/*` which resolves to its own `src/`. We
 *     map `@/` to `../sender/src/` so every such import lands on the real file.
 *
 *  2. WASM packages — `loader.ts` does `import "../../wasm-pkg/transfer_engine.js"`
 *     which is a real filesystem path relative to `sender/src/wasm/`, so Vite's
 *     default resolver finds it. `wasm-pack --target web` emits standard ESM
 *     that Vite bundles natively.
 *
 * The compress worker is spawned via the standard
 *   `new Worker(new URL("./workers/compress.worker.ts", import.meta.url), {type:"module"})`
 * form in options.tsx; Vite handles it as a separate entry and applies the same
 * `@/` alias inside the worker bundle.
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
      // Mirror the sender's tsconfig `@/*` -> `./src/*`, pointing at the real
      // sender source so cross-project imports resolve identically. Using the
      // { find, replacement } form with a trailing-slash replacement is the
      // reliable way to alias a path prefix under Vite/Rollup.
      { find: "@/", replacement: path.resolve(__dirname, "../sender/src/") + "/" },
    ],
  },
  // The transfer_engine wasm-pkg and the lzma/zstd loaders are only needed at
  // runtime; exclude them from Vite's dep pre-bundling to avoid mismatches.
  optimizeDeps: {
    exclude: ["lzma-wasm"],
  },
  server: {
    // QR scanning requires a clean screen; a stable port makes local testing
    // predictable across reloads.
    port: 5180,
    strictPort: false,
  },
  build: {
    // Emit a static site under dist/ that can be hosted anywhere (GitHub Pages,
    // Netlify, any static server). Relative base so it works under sub-paths
    // (e.g. username.github.io/repo/), not just site root.
    outDir: "dist",
    target: "esnext",
  },
  // Relative asset base: index.html emits `./assets/...` so the site works
  // under any sub-path without rewriting URLs. Note the worker's runtime
  // `new URL("wasm-zstd.wasm", self.location.href)` fetch also resolves
  // relative to the page, so wasm-zstd.wasm stays fetchable in sub-paths too.
  base: "./",
})
