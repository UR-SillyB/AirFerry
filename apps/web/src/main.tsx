/**
 * AirFerry web sender — entry point.
 *
 * Thin shell: the entire sender app (file/text select → QR stream → stats,
 * with transfer params on a separate settings page) lives in `src/options.tsx` (via the `@/` alias configured in
 * vite.config.ts / tsconfig.json). The same source serves the browser
 * extension build; extension-only bits (background worker, chrome.runtime.getURL)
 * are handled inside it via environment detection, so this file only mounts
 * the App.
 */
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
// `@/` points at src/; options.tsx is shared by the web + extension builds.
import App from "@/options"

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("#root element missing in index.html")

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
)
