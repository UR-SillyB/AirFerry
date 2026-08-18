import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist-standalone",
    lib: {
      entry: path.resolve(__dirname, "src/standalone.tsx"),
      formats: ["iife"],
      name: "AirFerryStandalone",
      fileName: () => "index.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    assetsInlineLimit: 100 * 1024,
    target: "esnext",
    cssCodeSplit: false,
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
})
