/**
 * AirFerry web sender — entry point.
 *
 * This is a thin shell: the entire sender app (file/text select → params → QR
 * stream → stats) is reused verbatim from the browser extension's
 * `apps/sender/src/options.tsx`. The extension-only bits (background worker,
 * chrome.runtime.getURL) are handled inside that shared source via environment
 * detection, so this file only needs to mount the App.
 */
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
// Reuse the sender's App component directly. The `@/` alias (configured in
// vite.config.ts and tsconfig.json) points at ../sender/src/, so this import
// lands on the real options.tsx without any duplication.
import App from "@/options"

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("#root element missing in index.html")

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
)
