/**
 * AFGrid 辅助：symbol_size 边界 + 边长预览（Rust WASM 单一事实源）。
 */
import { ensureWasm, afgridSideForSymbolSizeWasm } from "./loader"

export const AFGRID_SYMBOL_MIN = 256
export const AFGRID_SYMBOL_MAX = 16384

export function clampSymbolSize(n: number): number {
  return Math.max(
    AFGRID_SYMBOL_MIN,
    Math.min(AFGRID_SYMBOL_MAX, Math.round(n))
  )
}

let sideFn: ((symbolSize: number) => number) | null = null
let warmupPromise: Promise<void> | null = null

export function afgridSideForSymbolSize(symbolSize: number): number {
  return sideFn ? sideFn(symbolSize) : 0
}

export function warmupAfgridSide(): Promise<void> {
  if (warmupPromise) return warmupPromise
  warmupPromise = ensureWasm().then(() => {
    sideFn = (s: number) => afgridSideForSymbolSizeWasm(s) >>> 0
  })
  return warmupPromise
}
