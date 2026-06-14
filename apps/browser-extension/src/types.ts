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
  fps: 30,
  symbolSize: 1024,
  brightness: 1.0,
  autoOptimize: true
}
