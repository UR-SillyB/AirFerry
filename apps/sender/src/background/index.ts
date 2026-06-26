/**
 * Background service worker (MV3) / background page (MV2).
 *
 * Toolbar icon click → open the sender app in a new tab, directly.
 *
 * Browser extensions have two mutually exclusive "icon click" modes:
 *  (1) a declared `default_popup` (a small HTML window pops up on every click),
 *  (2) NO popup + an `chrome.action.onClicked` listener (the click runs code).
 * We want mode (2) so the user goes straight to the full-page app with no
 * intermediate popup+button. This file is that listener.
 *
 * Plasmo picks up `src/background/index.ts` by convention and emits it as the
 * background entry (`background.service_worker` under MV3, `background.scripts`
 * under MV2). `fix-manifest.cjs` then strips any stray `default_popup` so the
 * listener actually fires (a declared popup always takes precedence).
 *
 * MV3 exposes `chrome.action`; MV2 exposes `chrome.browserAction`. Exactly one
 * exists at runtime, so the fallback resolves cleanly on both manifest versions.
 */
const action = (chrome.action ?? chrome.browserAction)!

action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html") })
})
