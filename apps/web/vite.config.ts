import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { transferEngineSha256 } from "./scripts/wasm-fingerprint"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  define: {
    // Pinned at build time; src/wasm/loader.ts refuses a wasm whose SHA-256
    // differs (scripts/wasm-fingerprint.ts for the threat-model caveat).
    __WASM_TRANSFER_ENGINE_SHA256__: JSON.stringify(transferEngineSha256()),
  },
  resolve: {
    alias: [
      { find: "@/icons", replacement: path.resolve(__dirname, "src/components/icons.tsx") },
      { find: "@/", replacement: path.resolve(__dirname, "src/") + "/" },
      { find: "@airferry-wasm/", replacement: path.resolve(__dirname, "wasm-pkg/") + "/" },
    ],
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5180,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "index.html"),
      },
    },
  },
  base: "./",
})
