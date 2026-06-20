/**
 * QR Video Stream Renderer.
 *
 * Drives a Canvas2D render loop at 30/60 fps. Each tick pulls the next frame
 * from the Rust `SenderSessionWasm`, encodes it to a QR matrix (also in WASM),
 * and paints it. Applies quiet-zone margin, pure black/white contrast, and a
 * brightness filter optimized for camera scanning.
 */
import { useEffect, useRef, useCallback, useState } from "react"
import { SenderSessionWasm, ensureWasm } from "@/wasm/loader"

export interface QrStreamStats {
  frames: number
  fps: number
  throughputBps: number
  bytes: number
  elapsedMs: number
}

interface Props {
  /** Initialized sender session. */
  session: SenderSessionWasm
  /** Target frames per second (30 or 60). */
  fps: number
  /** Brightness multiplier for screen (1.0 = normal, >1 = brighter). */
  brightness: number
  /** Auto-optimize brightness/contrast for scanning. */
  autoOptimize: boolean
  /** Number of QR codes per screen frame (1 = single, 2/4 = multi-QR mode). */
  multiQr: number
  onStats?: (s: QrStreamStats) => void
  onError?: (e: Error) => void
}

export function QrStream({
  session,
  fps,
  brightness,
  autoOptimize,
  multiQr,
  onStats,
  onError
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number>(0)
  const lastPxRef = useRef<number>(0)
  const statsTimerRef = useRef<number>(0)
  const [fullscreen, setFullscreen] = useState(false)

  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) return

    // Decide single vs multi-QR mode. multiQr<=1 keeps the proven single-code
    // path (one next_qr call, fills the whole canvas). multiQr>=2 requests N
    // distinct symbols in one WASM call and tiles them in a grid.
    const wantMulti = multiQr >= 2

    // Collect the matrices to render this tick. Each entry: [side, modules].
    type Matrix = { side: number; modules: Uint8Array }
    let matrices: Matrix[]
    try {
      if (!wantMulti) {
        const sideBuf = new Uint32Array(1)
        const modules = session.next_qr(sideBuf)
        matrices = [{ side: sideBuf[0], modules }]
      } else {
        const buf = session.next_qr_multi(multiQr)
        matrices = parseMultiQrBuf(buf)
        if (matrices.length === 0) {
          // Nothing produced this tick; skip the redraw.
          return
        }
      }
    } catch (e) {
      onError?.(e as Error)
      return
    }

    // Layout: single → fills canvas; multi → grid (2 → 1×2, 4 → 2×2, else row).
    const n = matrices.length
    const cols = n === 2 ? 2 : n === 4 ? 2 : n
    const rows = Math.ceil(n / cols)
    const cssSize = canvas.clientWidth || 480 // Fallback to 480 if clientWidth is 0
    const dpr = window.devicePixelRatio || 1
    const px = Math.max(cssSize * dpr, 256)
    // Only resize the backing store when the target size actually changes.
    // Reassigning canvas.width/height every frame clears the surface and
    // forces the compositor to re-allocate its buffer — under sustained 60fps
    // load this degrades into periodic stalls (observed FPS sliding 60→40 as
    // the session runs longer). Caching the size keeps the GPU buffer stable.
    if (px !== lastPxRef.current) {
      lastPxRef.current = px
      canvas.width = px
      canvas.height = px
    }

    // Pure white background (max contrast) across the whole canvas.
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, px, px)

    // Each code occupies an equal cell with a small gap between cells (white
    // gutter also serves as quiet zone). The cell is square.
    const gap = wantMulti ? Math.round(px * 0.02) : 0
    const cellW = Math.floor((px - gap * (cols + 1)) / cols)
    const cellH = Math.floor((px - gap * (rows + 1)) / rows)
    const cell = Math.min(cellW, cellH)
    for (let i = 0; i < n; i++) {
      const c = i % cols
      const r = Math.floor(i / cols)
      const ox = gap + c * (cell + gap)
      const oy = gap + r * (cell + gap)
      drawMatrix(ctx, matrices[i].modules, matrices[i].side, ox, oy, cell)
    }

    // Stats throttle: ~4 Hz.
    const now = performance.now()
    if (now - statsTimerRef.current > 250) {
      statsTimerRef.current = now
      try {
        const raw = JSON.parse(session.stats_json())
        onStats?.({
          frames: raw.frames,
          fps: Number(raw.fps),
          throughputBps: Number(raw.throughput_bps),
          bytes: raw.bytes,
          elapsedMs: raw.elapsed_ms
        })
      } catch {
        /* ignore */
      }
    }
  }, [session, autoOptimize, brightness, multiQr, onStats, onError])

  // Apply brightness/contrast optimization at the canvas element level. This is
  // a constant for a given (brightness, autoOptimize) combination, so set it
  // once on mount / when those props change — NOT every render tick. Per-frame
  // `canvas.style.filter = ...` triggers style recalculation / compositor-layer
  // repaint every frame, which is wasted work when the filter never changes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const b = autoOptimize ? Math.max(brightness, 1.15) : brightness
    const filterParts = [`brightness(${b.toFixed(2)})`]
    if (autoOptimize) filterParts.push("contrast(1.1)")
    canvas.style.filter = filterParts.join(" ")
  }, [brightness, autoOptimize])

  useEffect(() => {
    let cancelled = false
    const interval = 1000 / Math.max(1, Math.min(120, fps))

    const loop = (ts: number) => {
      if (cancelled) return
      const delta = ts - lastTickRef.current
      if (delta >= interval) {
        // Anti-stall guard: if we fell behind by more than ~2 frames (e.g.
        // after a tab-switch, GC pause, or thermal throttle), snap to the
        // current timestamp instead of letting delta keep growing. Otherwise
        // the loop would fire several catch-up renders in rapid succession,
        // compounding the slowdown (the "60 → 40 and keeps dropping" cascade).
        lastTickRef.current = delta > interval * 3 ? ts : ts - (delta % interval)
        render()
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      cancelled = true
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [render, fps])

  const toggleFullscreen = useCallback(async () => {
    const el = canvasRef.current?.parentElement ?? canvasRef.current
    if (!el) return
    if (!document.fullscreenElement) {
      await el.requestFullscreen?.()
      setFullscreen(true)
    } else {
      await document.exitFullscreen?.()
      setFullscreen(false)
    }
  }, [])

  return (
    <div className="qr-stream">
      <div className="qr-canvas-wrap">
        <canvas ref={canvasRef} className="qr-canvas" />
      </div>
      <button onClick={toggleFullscreen} className="btn">
        {fullscreen ? "退出全屏" : "全屏播放"}
      </button>
    </div>
  )
}

/**
 * Draw one QR matrix into the square cell at (ox, oy) with side `cellPx`,
 * including the 4-module quiet zone and run-length dark-module batching. This
 * is the shared drawing routine used by both the single- and multi-QR paths.
 */
function drawMatrix(
  ctx: CanvasRenderingContext2D,
  matrix: Uint8Array,
  side: number,
  ox: number,
  oy: number,
  cellPx: number
) {
  const margin = 4
  const quiet = side + margin * 2
  // Module size that tiles evenly into the cell; floor keeps modules aligned.
  const modulePx = Math.max(1, Math.floor(cellPx / quiet))
  const drawSize = modulePx * quiet
  // Center the code within the cell.
  const offset = Math.floor((cellPx - drawSize) / 2)

  // White quiet-zone background for this cell (the global clear already painted
  // white, but re-painting the cell guarantees a clean gutter per code).
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(ox, oy, cellPx, cellPx)

  // Draw dark modules only, run-length batched per row.
  ctx.fillStyle = "#000000"
  for (let y = 0; y < side; y++) {
    const rowBase = y * side
    const py = oy + offset + (y + margin) * modulePx
    let runStart = -1
    for (let x = 0; x < side; x++) {
      const dark = matrix[rowBase + x] !== 0
      if (dark) {
        if (runStart < 0) runStart = x
      } else if (runStart >= 0) {
        ctx.fillRect(
          ox + offset + (runStart + margin) * modulePx,
          py,
          (x - runStart) * modulePx,
          modulePx
        )
        runStart = -1
      }
    }
    if (runStart >= 0) {
      ctx.fillRect(
        ox + offset + (runStart + margin) * modulePx,
        py,
        (side - runStart) * modulePx,
        modulePx
      )
    }
  }
}

/**
 * Parse the flat little-endian buffer returned by `next_qr_multi`:
 *   [u32 count][for each: u32 side + side*side bytes modules]
 * Returns the list of {side, modules}. An empty/short buffer yields [].
 *
 * The DataView reads over the same buffer the WASM call returned (a fresh
 * Uint8Array), so no extra copy is made beyond the slice views into modules.
 */
function parseMultiQrBuf(buf: Uint8Array): { side: number; modules: Uint8Array }[] {
  if (buf.length < 4) return []
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const count = dv.getUint32(0, true) // little-endian
  const out: { side: number; modules: Uint8Array }[] = []
  let pos = 4
  for (let i = 0; i < count && pos + 4 <= buf.length; i++) {
    const side = dv.getUint32(pos, true)
    pos += 4
    const n = side * side
    if (pos + n > buf.length) break // truncated; stop
    out.push({ side, modules: buf.subarray(pos, pos + n) })
    pos += n
  }
  return out
}
