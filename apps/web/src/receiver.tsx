/**
 * AirFerry web receiver — entry point.
 *
 * Thin shell mirroring main.tsx: mounts ReceivePage from `src/pages/`.
 * All receive logic (camera capture, QR decode, ingest, decompress, parse,
 * result rendering) lives in `src/pages/ReceivePage.tsx`, shared with the
 * browser extension via the same `@/` alias.
 */
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import ReceivePage from "@/pages/ReceivePage"

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("#root element missing in receiver.html")

createRoot(rootEl).render(
  <StrictMode>
    <ReceivePage />
  </StrictMode>
)
