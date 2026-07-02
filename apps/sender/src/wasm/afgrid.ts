/** AFGrid side length for symbol_size (matches Rust layout formula). */

const MIN = 256
const MAX = 16384

export function clampSymbolSize(n: number): number {
  return Math.max(MIN, Math.min(MAX, Math.round(n)))
}

/** Approximate matrix side (modules per edge) for AFGrid single code. */
export function afgridSideForSymbolSize(symbolSize: number): number {
  const frameLen = 64 + symbolSize
  const payloadLen = 2 + frameLen
  const chunks = Math.ceil(payloadLen / 200)
  let prot = 2
  let off = 0
  while off < payloadLen) {
    const dataLen = Math.min(200, payloadLen - off)
    const npar = Math.max(2, Math.ceil(dataLen * 0.1))
    prot += 2 + dataLen + npar
    off += dataLen
  }
  const bits = prot * 8
  const d = Math.max(8, Math.ceil(Math.sqrt(bits)))
  return d + 2
}

export { MIN as AFGRID_SYMBOL_MIN, MAX as AFGRID_SYMBOL_MAX }
