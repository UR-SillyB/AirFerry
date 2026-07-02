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

  // Pre-allocated, reused-across-frames WASM scratch buffers. The hot path
  // runs at up to 60fps; allocating fresh TypedArrays each tick heaps up GC
  // pressure that shows up as rAF jitter. These buffers live for the
  // component's whole lifetime and are fed to the zero-copy `next_qr_into`
  // export, which writes directly into them and returns only the byte count.
  //
  // Sizing: AFGrid side grows with symbol_size. symbol_size_max=16384 →
  // side≈378 → 378²=142884 modules. We size for the absolute ceiling with
  // headroom so any legal symbol_size never overflows. (QR V40=177²=31329 is
  // now a strict subset.) Rounding up to 160000 keeps alignment simple.
  //
  // ⚠ The subarray view handed to drawMatrix is only valid for the current
  // tick — the next tick overwrites the backing buffer. The render path reads
  // it to the Canvas within the same tick (putImageData is synchronous), so
  // this is safe; never store the view across frames.
  const MAX_MATRIX_SIDE = 400           // > 378 (symbol_size=16384 ceiling)
  const MAX_MATRIX_MODULES = MAX_MATRIX_SIDE * MAX_MATRIX_SIDE // 160000
  const matrixBufRef = useRef(new Uint8Array(MAX_MATRIX_MODULES))
  const sideBufRef = useRef(new Uint32Array(1))

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

    // AFGrid: always single large code (fills the whole canvas). multiQr is
    // ignored — the single-code path is the only path under AFGrid.
    type Matrix = { side: number; modules: Uint8Array }
    let matrix: Matrix
    try {
      const n = session.next_qr_into(matrixBufRef.current, sideBufRef.current)
      const side = sideBufRef.current[0]
      // subarray is a zero-copy view; valid only until the next tick.
      matrix = { side, modules: matrixBufRef.current.subarray(0, n) }
    } catch (e) {
      onErrorRef.current?.(e as Error)
      return
    }

    const cssSize = canvas.clientWidth || 480 // Fallback to 480 if clientWidth is 0
    const dpr = window.devicePixelRatio || 1
    const px = Math.max(cssSize * dpr, 256)
    // Only resize the backing store when the target size actually changes.
    if (px !== lastPxRef.current) {
      lastPxRef.current = px
      canvas.width = px
      canvas.height = px
    }

    // Pure white background (max contrast) across the whole canvas.
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, px, px)

    // Single code fills the entire canvas.
    const djx = ditherJitter ? Math.round((Math.random() - 0.5) * 2) : 0
    const djy = ditherJitter ? Math.round((Math.random() - 0.5) * 2) : 0
    drawMatrix(ctx, matrix.modules, matrix.side, djx, djy, px, 4)

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
  }, [session])

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
  // Center the code within the cell.
  const offset = Math.floor((cellPx - drawSize) / 2)

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

  // Plot dark modules as blocks of pixels. We tried replacing the inner
  // modulePx-wide row write with `Uint32Array.set(blackRow, offset)` (batch
  // copy of a pre-filled template), but benchmarking showed it is ~2× SLOWER
  // at the realistic modulePx (4–7): TypedArray.set has per-call overhead
  // (bounds check + memcpy setup) that exceeds the cost of 4–7 inline scalar
  // writes. The crossover where set() wins is modulePx ≥ 16, far above what
  // any real canvas size produces. The scalar loop below is the fast path.
  // White modules are skipped (buffer is already white).
  const black = 0xFF000000
  for (let y = 0; y < side; y++) {
    const rowBase = y * side
    const baseY = (y + margin) * modulePx
    for (let x = 0; x < side; x++) {
      if (matrix[rowBase + x] === 0) continue
      const baseX = (x + margin) * modulePx
      for (let dy = 0; dy < modulePx; dy++) {
        const row = (baseY + dy) * drawSize + baseX
        for (let dx = 0; dx < modulePx; dx++) {
          pixels[row + dx] = black
        }
      }
    }
  }

  // Single Canvas API call instead of ~500 fillRect per code.
  ctx.putImageData(imgData, ox + offset, oy + offset)
}

/**
 * Parse the flat little-endian buffer returned by `next_qr_multi_into`:
 *   [u32 count][for each: u32 side + side*side bytes modules]
 * Returns the list of {side, modules}. An empty/short buffer yields [].
 *
 * `len` is the number of bytes actually written by the WASM call (≤
 * buf.byteLength), so the parser stops at the real end of the data rather
 * than reading stale bytes from the reused backing buffer. The DataView reads
 * over the same buffer the WASM call returned (the caller's scratch buffer),
 * so no extra copy is made beyond the slice views into modules.
 */
