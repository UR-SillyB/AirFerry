/**
 * Standalone (single-file) web entry.
 *
 * Same as main.tsx but flips the `__AIRFERRY_STANDALONE__` flag BEFORE mounting
 * the app, so options.tsx/loader.ts pick the base64 + Blob-URL worker paths
 * instead of the fetch + module-worker paths (which fail under `file://`).
 *
 * The WASM base64 constants (`__WASM_TRANSFER_ENGINE__`, `__WASM_ZSTD__`) and
 * the worker source (`__WORKER_CODE__`) are injected at build time by
 * scripts/build-standalone.cjs, so they are already present on `globalThis` by
 * the time this runs (the inline `<script>` runs before the app bundle).
 */
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "@/options"

// Signal the standalone build to the shared sender source (options.tsx /
// loader.ts), which gate their fetch vs base64 / module-worker vs Blob-worker
// branches on this flag.
;(globalThis as { __AIRFERRY_STANDALONE__?: boolean }).__AIRFERRY_STANDALONE__ = true

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("#root element missing in index.html")

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
)
