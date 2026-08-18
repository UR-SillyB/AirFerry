/**
 * QR Video Stream Renderer.
 *
 * Drives a Canvas2D render loop. Each tick pulls the next frame from the Rust
 * `SenderSessionWasm` via its WASM-owned QR scratch buffer (fixed-mask
 * QR matrix, vendored fast_qr), expands modules to pixels in JS (`drawMatrix`),
 * and blits with one `putImageData` per code.
 *
 * Supports fps=0 (one symbol set per visible display refresh) and explicit
 * targets up to 240 for high-refresh displays.
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
  /** Target frames per second (0 = every display refresh). */
  fps: number
  /** Brightness multiplier for screen (1.0 = normal, >1 = brighter). */
  brightness: number
  /** Auto-optimize brightness/contrast for scanning. */
  autoOptimize: boolean
  /** Number of QR codes per screen frame (1 = single, 2/4 = multi-QR mode). */
  multiQr: number
  /** Sub-pixel dithering to break moiré patterns. */
  ditherJitter: boolean
  /** Stop playback, release the sender session, and return to configuration. */
  onStop: () => void
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
  onStop,
  onStats,
  onError
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number>(0)
  const lastPxRef = useRef<number>(0)
  const statsTimerRef = useRef<number>(0)
  const stoppedRef = useRef(false)
  const [fullscreen, setFullscreen] = useState(false)

  const onStatsRef = useRef(onStats)
  const onErrorRef = useRef(onError)
  onStatsRef.current = onStats
  onErrorRef.current = onError

  // A rAF callback is scheduled inside the effect's `loop` closure which binds
  // the `session` captured at render time. When the parent swaps the session
  // (e.g. a new send calls `releaseOwnedSession()` which frees the old
  // `SenderSessionWasm`), a still-queued rAF tick can run against
  // the *freed* session and wasm-bindgen then throws "null pointer passed to
  // rust" (use-after-free). `activeSessionRef` always holds the newest prop so
  // a stale loop can detect the swap and stop instead of touching freed WASM.
  const activeSessionRef = useRef(session)
  activeSessionRef.current = session

  const render = useCallback(() => {
    // The stop button releases the WASM session in the parent. Guard before
    // touching it so a queued animation callback cannot race that release.
    if (stoppedRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) return

    // This closure may be invoked by a rAF tick from a PREVIOUS `session`. The
    // parent has already `free()`d that session (segmented switch / reset), so
    // calling any method on it would dereference a null wasm pointer. Bail out
    // and let the owning effect's cleanup stop the loop — we must NOT touch the
    // shared `rafRef` here, because by the time a stale tick runs it may already
    // point at the NEW loop's frame id.
    if (activeSessionRef.current !== session) return

    const wantMulti = multiQr >= 2

    type Matrix = { side: number; modules: Uint8Array }
    let matrices: Matrix[]
    try {
      const written = session.next_qr_scratch(wantMulti ? multiQr : 1)
      // This is a direct view of stable WASM memory, not a wasm-bindgen
      // copy-in/copy-out slice. Consume it synchronously before the next WASM call.
      const scratch = session.qr_scratch_view()
      matrices = parseMultiQrBuf(scratch, written)
      if (matrices.length === 0) return
    } catch (e) {
      onErrorRef.current?.(e as Error)
      return
    }

    const n = matrices.length
    const cols = n === 2 ? 2 : n === 4 ? 2 : n
    const rows = Math.ceil(n / cols)
    const cssSize = canvas.clientWidth || 480
    const dpr = window.devicePixelRatio || 1
    const px = Math.max(cssSize * dpr, 256)
    if (px !== lastPxRef.current) {
      lastPxRef.current = px
      canvas.width = px
      canvas.height = px
    }

    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, px, px)

    // All codes in a session share the same QR version → same `side`. Compute
    // modulePx once from the per-code cell size, then pack codes edge-to-edge
    // with NO centering gap — the drawSize is the actual QR pixel size and we
    // place codes at tight grid positions. This is faster (no drawImage scaling)
    // and produces a compact QR cluster that's easier for a camera to frame.
    // Multi-code: margin=2 gives each code a 2-module quiet zone. Two adjacent
    // codes thus have 4 modules of white between them — meeting the QR spec
    // minimum (4 modules) while staying compact. Single code: full 4-module
    // margin (standard).
    const margin = wantMulti ? 2 : 4
    const quiet = matrices[0].side + margin * 2
    const cellW = Math.floor(px / cols)
    const cellH = Math.floor(px / rows)
    const cell = Math.min(cellW, cellH)
    const modulePx = Math.max(1, Math.floor(cell / quiet))
    const drawSize = modulePx * quiet
    // Grid origin: center the packed grid (cols*drawSize) within the canvas.
    const gridW = cols * drawSize
    const gridH = rows * drawSize
    const gridOx = Math.floor((px - gridW) / 2)
    const gridOy = Math.floor((px - gridH) / 2)

    for (let i = 0; i < n; i++) {
      const c = i % cols
      const r = Math.floor(i / cols)
      const ox = gridOx + c * drawSize
      const oy = gridOy + r * drawSize
      const djx = ditherJitter ? Math.round((Math.random() - 0.5) * 2) : 0
      const djy = ditherJitter ? Math.round((Math.random() - 0.5) * 2) : 0
      drawMatrix(ctx, matrices[i].modules, matrices[i].side, ox + djx, oy + djy, modulePx, margin)
    }

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
  }, [session, multiQr, ditherJitter])

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
    stoppedRef.current = false

    // Throttled mode: rAF with interval gating.
    const interval = fps === 0 ? 0 : 1000 / Math.max(1, Math.min(240, fps))

    const loop = (ts: number) => {
      if (cancelled || stoppedRef.current) return
      const delta = ts - lastTickRef.current
      if (interval === 0 || delta >= interval) {
        lastTickRef.current = interval === 0 || delta > interval * 3
          ? ts
          : ts - (delta % interval)
        render()
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      cancelled = true
      stoppedRef.current = true
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [render, fps])

  // Drop the module-level ImageData cache on unmount. The cache is keyed by
  // drawSize and each entry is drawSize²×4 bytes; it is bounded within a single
  // session (a handful of sizes) but would accumulate across tab/session reloads
  // with varying DPR or segment versions without this eviction.
  useEffect(() => {
    return () => {
      imgDataCache.clear()
    }
  }, [])

  const toggleFullscreen = useCallback(() => {
    setFullscreen((f) => !f)
  }, [])

  const stopPlayback = useCallback(() => {
    // Cancel locally before notifying the parent: onStop frees the WASM
    // session and unmounts this component.
    stoppedRef.current = true
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    setFullscreen(false)
    onStop()
  }, [onStop])

  return (
    <div className="qr-stream">
      <div className={`qr-canvas-wrap${fullscreen ? " qr-fullscreen--active" : ""}`}>
        <canvas ref={canvasRef} className="qr-canvas" />
        {fullscreen && (
          <div className="qr-fullscreen-actions">
            <button onClick={toggleFullscreen} className="btn">退出全屏</button>
            <button onClick={stopPlayback} className="btn danger">停止播放</button>
          </div>
        )}
      </div>
      <div className="qr-actions">
        <button onClick={toggleFullscreen} className="btn secondary">
          {fullscreen ? "退出全屏" : "全屏播放"}
        </button>
        <button onClick={stopPlayback} className="btn danger">
          停止播放
        </button>
      </div>
    </div>
  )
}

/**
 * Draw one QR module matrix into the canvas. Uses a cached ImageData buffer
 * and a Uint32Array view for fast pixel writes, then a single putImageData.
 */
const imgDataCache = new Map<number, ImageData>()

function drawMatrix(
  ctx: CanvasRenderingContext2D,
  matrix: Uint8Array,
  side: number,
  ox: number,
  oy: number,
  modulePx: number,
  margin: number
) {
  const quiet = side + margin * 2
  const drawSize = modulePx * quiet

  // Obtain a reusable ImageData for this drawSize.
  let imgData = imgDataCache.get(drawSize)
  if (!imgData || imgData.width !== drawSize) {
    imgData = ctx.createImageData(drawSize, drawSize)
    imgDataCache.set(drawSize, imgData)
  }
  
  // CRITICAL PERFORMANCE NOTE: We must construct a new Uint32Array view over
  // imgData.data.buffer EVERY tick. Do NOT cache the Uint32Array itself. 
  // Calling ctx.putImageData() can cause the browser's graphics engine to detach, 
  // lock, or COW (copy-on-write) the underlying ArrayBuffer. Re-evaluating the 
  // view ensures we always write to the correct, fast memory backing. Caching 
  // the view caused a reproducible ~10% performance regression in V8.
  const pixels = new Uint32Array(imgData.data.buffer)

  pixels.fill(0xFFFFFFFF) // white

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

  ctx.putImageData(imgData, ox, oy)
}

function parseMultiQrBuf(
  buf: Uint8Array,
  len: number = buf.length
): { side: number; modules: Uint8Array }[] {
  if (len < 4) return []
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const count = dv.getUint32(0, true)
  const out: { side: number; modules: Uint8Array }[] = []
  let pos = 4
  for (let i = 0; i < count && pos + 4 <= len; i++) {
    const side = dv.getUint32(pos, true)
    pos += 4
    const n = side * side
    if (pos + n > len) break
    out.push({ side, modules: buf.subarray(pos, pos + n) })
    pos += n
  }
  return out
}
