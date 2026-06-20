/** Shared types for the sender app. */

export type Page = "select" | "params" | "play" | "stats"

export interface TransferConfig {
  redundancyPct: number
  fps: number
  symbolSize: number
  brightness: number
  autoOptimize: boolean
  /**
   * Number of QR codes rendered per screen frame (multi-QR mode).
   * 1 = single code. 4 = four distinct symbols per tick, each rendered as a
   * separate QR tiled on screen; a receiver that decodes all of them multiplies
   * throughput by ~this factor. The receiver must also have multi-QR decoding
   * enabled (it's on by default), or it will read only one code per frame.
   * The UI now exposes this as an on/off switch: on → 4 codes, off → 1.
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
    blurb: "V16，最易扫",
  },
  {
    id: "fast",
    label: "高速（896B）",
    symbolSize: 896,
    fps: 60,
    blurb: "V21，吞吐提升 1.7×",
  },
  {
    id: "extreme",
    label: "极限（1008B）",
    symbolSize: 1008,
    fps: 60,
    blurb: "V22，最高吞吐",
  },
]

/** Find the preset whose symbolSize matches, or null for a custom value. */
export function presetForSymbolSize(symbolSize: number): SpeedPresetDef | null {
  return SPEED_PRESETS.find((p) => p.symbolSize === symbolSize) ?? null
}

export const DEFAULT_CONFIG: TransferConfig = {
  redundancyPct: 5,
  fps: 60,
  symbolSize: 1008,
  brightness: 1.0,
  autoOptimize: true,
  // 4 = four codes tiled per frame (default). Multi-QR tiles N distinct symbols
  // on screen per tick for ~N× throughput, at the cost of each code being
  // smaller/harder to scan; the receiver has multi-QR decoding on by default.
  // The UI exposes this as an on/off switch (on → 4, off → 1).
  multiQr: 4
}

/** localStorage key under which the sender's transfer config is persisted. */
const CONFIG_STORAGE_KEY = "easytransfer.config"

/**
 * Load a saved config from localStorage, falling back to [DEFAULT_CONFIG] when
 * nothing is stored (or a field is missing after a version upgrade). The config
 * is the set of user-adjustable transfer params (redundancy, fps, symbol size,
 * brightness, auto-optimize, multi-QR); persisting it means the user does not
 * have to re-tune them on every transfer.
 */
export function loadConfig(): TransferConfig {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const saved = JSON.parse(raw) as Partial<TransferConfig>
    // Merge over the defaults so a new field added in a later version picks up
    // its default instead of leaking through as undefined.
    return { ...DEFAULT_CONFIG, ...saved }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Persist the config to localStorage. Silently ignores write failures (e.g.
 * private mode / quota) — the in-memory config still drives the current
 * transfer; only the "remember for next time" guarantee is lost.
 */
export function saveConfig(config: TransferConfig): void {
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config))
  } catch {
    /* ignore storage failures */
  }
}
