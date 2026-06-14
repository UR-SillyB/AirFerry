/** Shared types for the sender app. */

export type Page = "select" | "params" | "play" | "stats"

export interface TransferConfig {
  redundancyPct: number
  fps: number
  symbolSize: number
  brightness: number
  autoOptimize: boolean
}

export const DEFAULT_CONFIG: TransferConfig = {
  redundancyPct: 10,
  // 30fps (not 60): a QR needs to stay on screen long enough for the receiver
  // camera to capture a clean frame. 60fps showed each frame ~16ms — too brief
  // for reliable capture, so large files never accumulated enough symbols and
  // stuck at "恢复中 0%".
  fps: 30,
  // 512-byte symbols keep each frame at QR Version 16 (81×81) instead of the
  // 1024-byte / V23 (109×109) code, scanning far more reliably from a phone
  // camera. The header carries symbol_size, so the receiver adapts automatically.
  symbolSize: 512,
  brightness: 1.0,
  autoOptimize: true
}
