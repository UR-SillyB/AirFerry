/** Shared types for the sender app. */

export type Page = "select" | "params" | "play" | "stats"

export interface TransferConfig {
  redundancyPct: number
  fps: number
  symbolSize: number
  brightness: number
  autoOptimize: boolean
  /**
   * Number of QR codes rendered per screen frame (experimental multi-QR mode).
   * 1 = single code (default). 2/4 = that many distinct symbols per tick, each
   * rendered as a separate QR tiled on screen; a receiver that decodes all of
   * them multiplies throughput by ~this factor. The receiver must also enable
   * multi-QR decoding, or it will read only one code per frame.
   */
  multiQr: number
}

/**
 * Speed presets bundle a (symbolSize, fps) pair into a single user-facing
 * choice. Larger symbols pack more payload per frame (the QR header carries
 * symbol_size, so the receiver auto-adapts), but produce a denser QR that's
 * harder for a phone camera to resolve — so each step up also assumes a cleaner
 * scanning setup. The theoretical no-loss payload throughput at each preset
 * (factoring the 60-byte frame header + 4-byte footer + ~1/16 descriptor
 * overhead) is roughly:
 *
 *   稳定 (512B):  ~21 KiB/s @45fps,  ~28 KiB/s @60fps   (V16, 81×81)
 *   高速 (768B):  ~32 KiB/s @45fps,  ~42 KiB/s @60fps   (V19, 93×93)
 *   高速 (896B):  ~37 KiB/s @45fps,  ~49 KiB/s @60fps   (V21, 101×101)
 *   极限 (1008B): ~42 KiB/s @45fps,  ~55 KiB/s @60fps   (V22, 105×105)
 *
 * 1008B (not the full 1024B core default) is chosen so a frame (header +
 * payload + footer = 1072 B) still fits comfortably under V22's byte-mode L
 * capacity, leaving the version-fallback headroom in qr_render.rs to recover
 * the occasional un-encodable repair frame without jumping to V23.
 */
export type SpeedPreset = "stable" | "fast" | "extreme"

export interface SpeedPresetDef {
  id: SpeedPreset
  label: string
  symbolSize: number
  /** Recommended fps used when the user picks this preset. */
  fps: number
  blurb: string
}

export const SPEED_PRESETS: SpeedPresetDef[] = [
  {
    id: "stable",
    label: "稳定（512B）",
    symbolSize: 512,
    fps: 45,
    blurb: "V16 小码，最易扫，适合远距离 / 弱光 / 老设备",
  },
  {
    id: "fast",
    label: "高速（896B）",
    symbolSize: 896,
    fps: 60,
    blurb: "V21，吞吐约 1.7×，需要良好光线和对焦",
  },
  {
    id: "extreme",
    label: "极限（1008B）",
    symbolSize: 1008,
    fps: 60,
    blurb: "V22，吞吐约 2×，需要近距 + 稳定 + 高刷屏",
  },
]

/** Find the preset whose symbolSize matches, or null for a custom value. */
export function presetForSymbolSize(symbolSize: number): SpeedPresetDef | null {
  return SPEED_PRESETS.find((p) => p.symbolSize === symbolSize) ?? null
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
  // The "稳定" speed preset; pick a larger size (高速/极限) for ~2× throughput
  // on clean scanning setups.
  symbolSize: 512,
  brightness: 1.0,
  autoOptimize: true,
  // 1 = single QR per frame (default, most reliable). Multi-QR (2/4) is an
  // experimental mode that tiles N distinct symbols on screen per tick for
  // ~N× throughput, at the cost of each code being smaller/harder to scan and
  // requiring the receiver to decode multiple codes per frame.
  multiQr: 1
}
