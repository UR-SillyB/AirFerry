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
  fps: 60,  // Upgraded from 30 to 60 for 2x throughput
  symbolSize: 1024,
  brightness: 1.0,
  autoOptimize: true
}
