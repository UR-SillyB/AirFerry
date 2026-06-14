/**
 * QR Video Stream Renderer.
 *
 * Drives a Canvas2D render loop at 30/60 fps. Each tick pulls the next frame
 * from the Rust `SenderSessionWasm`, encodes it to a QR matrix (also in WASM),
 * and paints it. Applies quiet-zone margin, pure black/white contrast, and a
 * brightness filter optimized for camera scanning.
 */
import { useEffect, useRef, useCallback, useState } from "react"
import { SenderSessionWasm, encode_qr, ensureWasm } from "@/wasm/loader"

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
  onStats?: (s: QrStreamStats) => void
  onError?: (e: Error) => void
}

export function QrStream({
  session,
  fps,
  brightness,
  autoOptimize,
  onStats,
  onError
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastTickRef = useRef<number>(0)
  const statsTimerRef = useRef<number>(0)
  const [fullscreen, setFullscreen] = useState(false)

  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) return

    // Pull next frame + encode QR (both in WASM).
    let frameBytes: Uint8Array
    let matrix: Uint8Array
    let side: number
    try {
      frameBytes = session.next_frame()
      const sideBuf = new Uint32Array(1)
      matrix = encode_qr(frameBytes, sideBuf)
      side = sideBuf[0]
    } catch (e) {
      onError?.(e as Error)
      return
    }

    // Quiet-zone margin (4 modules per QR spec) + module scale to fill canvas.
    const margin = 4
    const quiet = side + margin * 2
    // Fit matrix into canvas; pick a module size that tiles evenly.
    const cssSize = canvas.clientWidth
    const dpr = window.devicePixelRatio || 1
    const px = Math.max(cssSize, 256)
    canvas.width = px
    canvas.height = px
    const modulePx = Math.floor(px / quiet)
    const drawSize = modulePx * quiet
    const offset = Math.floor((px - drawSize) / 2)

    // Pure white background (max contrast).
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, px, px)

    // Draw dark modules only (sparse fill is faster than per-module rects for
    // dense codes, but per-rect is simplest and correct).
    ctx.fillStyle = "#000000"
    for (let y = 0; y < side; y++) {
      const rowBase = y * side
      const py = offset + (y + margin) * modulePx
      for (let x = 0; x < side; x++) {
        if (matrix[rowBase + x]) {
          ctx.fillRect(
            offset + (x + margin) * modulePx,
            py,
            modulePx,
            modulePx
          )
        }
      }
    }

    // Apply brightness/contrast optimization at the canvas element level.
    const filterParts: string[] = []
    const b = autoOptimize ? Math.max(brightness, 1.15) : brightness
    filterParts.push(`brightness(${b.toFixed(2)})`)
    if (autoOptimize) filterParts.push("contrast(1.1)")
    canvas.style.filter = filterParts.join(" ")

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
  }, [session, autoOptimize, brightness, onStats, onError])

  useEffect(() => {
    let cancelled = false
    const interval = 1000 / Math.max(1, Math.min(120, fps))

    const loop = (ts: number) => {
      if (cancelled) return
      if (ts - lastTickRef.current >= interval) {
        lastTickRef.current = ts
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
