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
 * Built as a standalone IIFE `background.js` across MV2 and MV3.
 * MV3 (Chrome) runs it as a service_worker; MV2 and Firefox run it as background.scripts.
 *
 * MV3 exposes `chrome.action`; MV2 exposes `chrome.browserAction`. Exactly one
 * exists at runtime, so the fallback resolves cleanly on both manifest versions.
 */
const action = (chrome.action ?? chrome.browserAction)!

action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html") })
})
