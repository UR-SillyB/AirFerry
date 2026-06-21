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
  /** Sub-pixel dithering to break moiré patterns. */
  ditherJitter: boolean
  onStats?: (s: QrStreamStats) => void
  onError?: (e: Error) => void
}

export function QrStream({
  session,
  fps,
  brightness,
  autoOptimize,
  multiQr,
  ditherJitter,
  onStats,
  onError
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number>(0)
  const lastPxRef = useRef<number>(0)
  const statsTimerRef = useRef<number>(0)
  const [fullscreen, setFullscreen] = useState(false)

  // Refs for callback props so the render function's useCallback identity stays
  // stable across parent re-renders. Without this, an inline arrow function
  // (e.g. onError={(e) => setError(...)}) gets a new identity every time the
  // parent re-renders — which happens every ~250ms via onStats → setStats.
  // That would recreate `render`, which would restart the rAF loop (cancel +
  // reschedule), causing periodic frame drops. By reading callbacks through
  // refs we keep `render` dependent only on [session, multiQr].
  const onStatsRef = useRef(onStats)
  const onErrorRef = useRef(onError)
  onStatsRef.current = onStats
  onErrorRef.current = onError

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
      onErrorRef.current?.(e as Error)
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

    // Each code occupies an equal square cell, packed edge-to-edge. In multi-QR
    // mode the 1px separator is removed (the quiet zone already provides enough
    // white between codes) and drawMatrix centers the code with zero offset so
    // the grid has no dead space between adjacent codes.
    const sep = 0
    const cell = Math.floor(px / (wantMulti ? cols : 1))
    for (let i = 0; i < n; i++) {
      const c = i % cols
      const r = Math.floor(i / cols)
      const ox = c * (cell + sep)
      const oy = r * (cell + sep)
      // Sub-pixel dithering: shift each code by ±1px per frame to break
      // moiré patterns.  ±1px is kept as a whole integer so Canvas2D stays
      // on the GPU-accelerated integer path (sub-pixel fillRect is ~5× slower).
      const djx = ditherJitter ? Math.round((Math.random() - 0.5) * 2) : 0
      const djy = ditherJitter ? Math.round((Math.random() - 0.5) * 2) : 0
      drawMatrix(ctx, matrices[i].modules, matrices[i].side, ox + djx, oy + djy, cell, wantMulti ? 1 : 4)
    }

    // Stats throttle: ~4 Hz.
    const now = performance.now()
    if (now - statsTimerRef.current > 250) {
      statsTimerRef.current = now
      try {
        const raw = JSON.parse(session.stats_json())
        onStatsRef.current?.({
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
  }, [session, multiQr])

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

  // Web-level "fullscreen": the SAME canvas/wrapper DOM node persists in both
  // modes — only the wrapper's className flips. When .qr-fullscreen--active is
  // applied, CSS turns the wrapper into a fixed inset:0 overlay and sizes the
  // canvas to the viewport; without it, the wrapper is the normal centered
  // .qr-canvas-wrap. Because React never remounts the canvas, the rAF loop and
  // lastPxRef stay valid, and the next tick reads the new clientWidth to resize
  // the backing store. This is deliberately NOT the browser Fullscreen API
  // (no user-gesture/permission/OS handoff; covers only the page viewport).
  const toggleFullscreen = useCallback(() => {
    setFullscreen((f) => !f)
  }, [])

  return (
    <div className="qr-stream">
      <div className={`qr-canvas-wrap${fullscreen ? " qr-fullscreen--active" : ""}`}>
        <canvas ref={canvasRef} className="qr-canvas" />
        {fullscreen && (
          <button onClick={toggleFullscreen} className="btn qr-fullscreen-exit">
            退出全屏
          </button>
        )}
      </div>
      <button onClick={toggleFullscreen} className="btn">
        {fullscreen ? "退出全屏" : "全屏播放"}
      </button>
    </div>
  )
}

/**
 * Draw one QR matrix into the square cell at (ox, oy) with side `cellPx`,
 * using a single putImageData per code instead of per-module fillRect calls.
 * On GPU-backed Canvas2D (especially Windows D3D11) thousands of small fillRect
 * calls per frame create a CPU-GPU sync bottleneck; ImageData writes avoid the
 * per-call overhead by batching all pixel updates into one transfer.
 *
 * [imgDataCache] holds reusable ImageData objects keyed by drawSize so we
 * never re-allocate the buffer on every frame — just re-fill the existing one.
 */
const imgDataCache = new Map<number, ImageData>()

function drawMatrix(
  ctx: CanvasRenderingContext2D,
  matrix: Uint8Array,
  side: number,
  ox: number,
  oy: number,
  cellPx: number,
  /** Quiet-zone margin in modules: 4 = QR spec, 1 = tight (multi-code only). */
  margin: number
) {
  const quiet = side + margin * 2
  // Module size that tiles evenly into the cell; floor keeps modules aligned.
  const modulePx = Math.max(1, Math.floor(cellPx / quiet))
  const drawSize = modulePx * quiet
  // Center the code within the cell only for single-code mode (margin=4).
  // In multi-code mode (margin=1) align to top-left so the gap between
  // adjacent codes is minimized (just the quiet-zone overlap).
  const offset = margin >= 4 ? Math.floor((cellPx - drawSize) / 2) : 0

  // Obtain a reusable ImageData for this drawSize.
  let imgData = imgDataCache.get(drawSize)
  if (!imgData || imgData.width !== drawSize) {
    imgData = ctx.createImageData(drawSize, drawSize)
    imgDataCache.set(drawSize, imgData)
  }
  // Uint32 view: one uint32 per pixel (RGBA packed as 0xAABBGGRR on LE).
  const pixels = new Uint32Array(imgData.data.buffer)

  // Initialize to white (0xFFFFFFFF on little-endian = A=255,B=255,G=255,R=255).
  pixels.fill(0xFFFFFFFF)

  // Plot dark modules as blocks of pixels.
  const black = 0xFF000000
  for (let y = 0; y < side; y++) {
    const rowBase = y * side
    const baseY = (y + margin) * modulePx
    for (let x = 0; x < side; x++) {
      if (matrix[rowBase + x] !== 0) {
        const baseX = (x + margin) * modulePx
        for (let dy = 0; dy < modulePx; dy++) {
          const row = (baseY + dy) * drawSize
          const end = baseX + modulePx
          for (let dx = baseX; dx < end; dx++) {
            pixels[row + dx] = black
          }
        }
      }
    }
  }

  // Single Canvas API call instead of ~500 fillRect per code.
  ctx.putImageData(imgData, ox + offset, oy + offset)
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
