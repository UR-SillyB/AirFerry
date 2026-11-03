/**
 * AirFerry web receiver — single-file entry point.
 *
 * Sets `__AIRFERRY_STANDALONE__` BEFORE mounting ReceivePage so the worker
 * factory uses Blob-URL workers and the WASM loaders read the base64 constants
 * injected by scripts/build-receiver-standalone.cjs. Everything else (camera /
 * screen capture, QR pool, ingest, decompress, result UI) is the shared
 * ReceivePage from the sender source.
 */
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import ReceivePage from "@/pages/ReceivePage"

;(globalThis as { __AIRFERRY_STANDALONE__?: boolean }).__AIRFERRY_STANDALONE__ =
  true

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("#root element missing in the standalone receiver")

createRoot(rootEl).render(
  <StrictMode>
    <ReceivePage />
  </StrictMode>
)
