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
  // 25% redundancy: a better default than 10% for real-world scanning where
  // the receiver often reports 30–50% frame loss. RaptorQ needs K unique
  // symbols per block to decode; at 40% loss the receiver keeps ~60% of each
  // pass, so a single pass yields ~0.6×(1+R/100)×K usable symbols. With 10%
  // redundancy that's only ~0.66×K (forces 2 full passes); 25% gives more
  // headroom for bursty loss without wasting as much as 50%. Tune up for
  // higher-loss links, down for clean ones.
  redundancyPct: 25,
  // 45fps default: a balance between scan reliability and throughput. The
  // sender's distinct-frames/sec is the real cap on receive speed — at 30fps a
  // receiver (even a fast parallel-decode one) can capture at most 30 distinct
  // frames/sec. 45fps lifts that ceiling while keeping each QR on screen long
  // enough (~22ms) for a 60fps-capturing camera to grab a clean frame. Users on
  // clean, well-lit setups can pick 60; high-loss setups can drop to 30.
  fps: 45,
  // 512-byte symbols keep each frame at QR Version 16 (81×81) instead of the
  // 1024-byte / V23 (109×109) code, scanning far more reliably from a phone
  // camera. The header carries symbol_size, so the receiver adapts automatically.
  symbolSize: 512,
  brightness: 1.0,
  autoOptimize: true
}
