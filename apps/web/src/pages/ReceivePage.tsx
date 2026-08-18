/**
 * Web receiver page — scan the sender's QR video stream and recover the
 * file/text/bundle.
 *
 * Pipeline (all off-main-thread where possible):
 *   camera (getUserMedia) or screen/tab capture (getDisplayMedia) → video element
 *     → requestVideoFrameCallback captures a frame
 *       → qr-decode.worker (FAST ZXing-C++ WASM) decodes all QR payloads
 *         → receive.worker ingests them (serial; Rust receiver not thread-safe)
 *           → on complete: assemble canonical stream → verify_final_stream
 *             (chunk table + entry hashes + UTF-8 + Content ID) → materialize
 *             entries per the Manifest
 *
 * The entry screen shows a source selector (camera / screen capture). The
 * screen option is hidden where getDisplayMedia is unavailable (mobile
 * browsers), leaving the camera-only UI exactly as before.
 */

import { useState, useCallback, useRef, useEffect } from "react"
import "@/assets/app.css"
import "@/assets/receive.css"
import {
  CheckCircleIcon,
  CheckIcon,
  ErrorIcon,
  FileIcon,
  HistoryIcon,
  PackageIcon,
  TextDocIcon,
  WarningIcon,
} from "@/components/icons"
import iconUrl from "../../assets/receiver-icon128.png"
import type { Recovered } from "@/receive/parse"
import { ensureWasm } from "@/wasm/loader"
import { createZipBlob } from "@/lib/zip"
import {
  recordPartialTransfer,
  recordCompletedTransfer,
} from "@/storage/receiveHistory"
import { HistoryModal } from "@/components/HistoryModal"

type Stage = "camera" | "scanning" | "recovering" | "done" | "error"

/** Scan source chosen on the entry screen: camera or screen/tab capture. */
type ScanSourceKind = "camera" | "display"

/** Mirrors Android ScanActivity's UI state — the shared receiver UX. */
interface ProgressInfo {
  progressPct: number
  receivedSymbols: number
  totalSymbols: number
  decodedSymbols: number
  decodedBlocks: number
  totalBlocks: number
  decodedFraction: number
  metaConfirmed: boolean
  symbolSize: number
  /** v1-magic frames rejected; > 0 ⇒ peer runs protocol 1 (F2 hint). */
  legacyPeerFrames: number
  lossPct: number
  framesSeen: number
  framesDropped: number
  decodePerSec: number
  recentWireBps: number
  /** Avg decoded QR codes per processed frame — helps diagnose why 4-code
   *  throughput isn't 4× (missed codes vs low fps). */
  avgCodesPerFrame: number
  transferElapsedMs: number
  complete: boolean
  fileName: string
  fileSize: number
  compressedSize: number
  compressedSizeKnown: boolean
  /** Derived status line (same semantics as Android). */
  statusText: string
}

/** Sliding-window constants (match Android ScanActivity). */
const RATE_WINDOW_MS = 3000
const RATE_MIN_DT_MS = 300

/**
 * Decode at the camera's native resolution — never downscale. Downscaling
 * shrinks the QR cells, which makes zxing work HARDER to resolve them (worse
 * decode success at high frame rate). Instead we decode full-res and let the
 * ROI grid (2×2 for 4 codes/frame) feed zxing small per-cell images: the code
 * keeps full detail (easy to read) while the per-cell scan area is tiny (fast).
 * `> 0` here is a safety cap only for absurd cameras (e.g. 4K) — leave disabled.
 */
const DECODE_MAX_WIDTH = 0 // 0 = never downscale; cap only if > 0

/**
 * QR decode worker pool size. The single biggest latency in the web receiver is
 * the ZXing decode; a pool lets N frames be decoded in parallel across the
 * browser's cores (mirrors Android's native thread pool). Each worker owns its
 * own zxing WASM instance. Ingest stays serialized via the single receive worker.
 * 4 aligns with the 4-code sender mode (one worker per code/frame on a quad-core
 * phone). Going higher than the core count just adds WASM memory + scheduling
 * overhead, so 4 is a good default; bump it on 8-core devices if useful.
 */
const QR_WORKER_POOL = 4

/** One rate sample: a wall-clock tick + symbol counts at that instant. */
interface RateSample {
  tMs: number
  decoded: number
  receivedSymbols: number
  /** Processed-frame count at this instant (for per-frame code average). */
  frames: number
}

/** Format bytes as a compact size (matches Android formatSize). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Format ms as a duration like "23 秒" / "1 分 05 秒" (matches Android). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec} 秒`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m} 分 ${String(s).padStart(2, "0")} 秒`
}

/**
 * Revoke a download URL late rather than on a 0ms timeout. Result Blobs can be
 * lazy references into the OPFS spill file; the browser streams them while the
 * download runs, and revoking on the next tick can abort that stream.
 */
function revokeDownloadUrlLater(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Extract a Y (luminance) plane from the live video for the fast backend.
 *
 * We draw to canvas and convert RGBA→Y explicitly. This guarantees a tightly
 * packed Y plane with rowStride == width, which is what `airferry_wasm_decode
 * _multi_y` expects. (`VideoFrame.copyTo(I420)` was tried first but its Y plane
 * is laid out with a coded-stride ≥ width and codedWidth ≥ displayWidth, so a
 * naive `subarray(0, w*h)` misaligns rows and the decoder reads garbage — that
 * is why it's NOT used here.)
 */
function extractYPlane(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  w: number,
  h: number
): Uint8Array | null {
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, w, h)
    const img = ctx.getImageData(0, 0, w, h)
    const rgba = img.data
    const y = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) {
      const o = i * 4
      y[i] = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29 + 128) >> 8
    }
    return y
  } catch {
    return null
  }
}

/** Zeroed progress used on mount / scan start / reset. */
function initialProgress(): ProgressInfo {
  return {
    progressPct: 0,
    receivedSymbols: 0,
    totalSymbols: 0,
    decodedSymbols: 0,
    decodedBlocks: 0,
    totalBlocks: 0,
    decodedFraction: 0,
    metaConfirmed: false,
    symbolSize: 0,
    legacyPeerFrames: 0,
    lossPct: 0,
    framesSeen: 0,
    framesDropped: 0,
    decodePerSec: 0,
    recentWireBps: 0,
    avgCodesPerFrame: 0,
    transferElapsedMs: 0,
    complete: false,
    fileName: "",
    fileSize: 0,
    compressedSize: 0,
    compressedSizeKnown: false,
    statusText: "等待二维码…",
  }
}

/**
 * Progress bar tracks *received (de-duplicated) symbols*, not decoded symbols —
 * RaptorQ decodes whole blocks at once, so a decoded-fraction bar sits flat and
 * then jumps. Fountain repair symbols can push receivedSymbols above total K,
 * so clamp to 100. Mirrors Android ScanActivity's pct derivation.
 */
function computePct(
  complete: boolean,
  metaConfirmed: boolean,
  totalSymbols: number,
  receivedSymbols: number
): number {
  if (complete) return 100
  if (metaConfirmed || totalSymbols > 0) {
    if (totalSymbols > 0) {
      const pct = Math.min(100, Math.max(0, Math.floor((receivedSymbols * 100) / totalSymbols)))
      // Before meta is confirmed, total_symbols is only an estimate from the
      // frame header; don't over-promise early (cap at 15%, mirroring Android's
      // estimatedTotalSymbols logic).
      return metaConfirmed ? pct : Math.min(15, pct)
    }
    return 0
  }
  return 0
}

/** Same status-line semantics as Android ScanActivity. */
function computeStatusText(
  complete: boolean,
  metaConfirmed: boolean,
  totalSymbols: number,
  receivedSymbols: number,
  decodedBlocks: number,
  pct: number,
  legacyPeerFrames = 0
): string {
  if (complete) return "文件恢复完成"
  if (legacyPeerFrames > 0)
    return `检测到旧版 v1 协议二维码（已拒 ${legacyPeerFrames} 帧），请将发送端升级到 AF2 版本`
  if (!metaConfirmed && receivedSymbols > 0)
    return `正在同步… 已缓存 ${receivedSymbols} 符号 (~${pct}%)`
  if (totalSymbols === 0) return "等待二维码…"
  if (receivedSymbols > 0 && decodedBlocks === 0)
    return `接收中… ${receivedSymbols}/${totalSymbols} 符号 (等待解码)`
  return `恢复中… ${pct}%`
}

interface ResultInfo {
  recovered: Recovered
  name?: string
}

/** Progress fields shipped by receive.worker's status message. */
interface ProgressSnapshot {
  totalSymbols: number
  decodedSymbols: number
  receivedSymbols: number
  decodedBlocks: number
  totalBlocks: number
  decodedFraction: number
  metaConfirmed: boolean
  symbolSize: number
  legacyPeerFrames: number
  complete: boolean
  fileName?: string
  fileSize?: number
  totalRawSize?: number
  transferIdHex?: string
  entryCount?: number
  chunkCount?: number
}

/**
 * Spawn the receive worker. Vite recognizes the `new URL("./...", import.meta.url)`
 * literal and emits the worker as a chunk.
 */
function createReceiveWorker(): Worker {
  return new Worker(new URL("../workers/receive.worker.ts", import.meta.url), {
    type: "module",
  })
}

/** Spawn the QR decode worker. */
function createQrWorker(): Worker {
  return new Worker(new URL("../workers/qr-decode.worker.ts", import.meta.url), {
    type: "module",
  })
}

export function ReceivePage(): React.ReactElement {
  const [stage, setStage] = useState<Stage>("camera")
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressInfo>(() => initialProgress())
  const [result, setResult] = useState<ResultInfo | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  // End-to-end capture fps (how often captureLoop runs) — shown in the corner to
  // diagnose whether the 120 codes/s ceiling is camera fps (30) vs decode speed.
  const [captureFps, setCaptureFps] = useState<number>(0)
  // Scan source selection on the entry screen. displaySupported is detected
  // once: mobile browsers have no getDisplayMedia, so the option hides there.
  const [source, setSource] = useState<ScanSourceKind>("camera")
  const [displaySupported] = useState<boolean>(() =>
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === "function"
  )

  // In-flight transfer metadata tracking for history & resume
  const activeTransferIdRef = useRef<string>("")
  const activeNameRef = useRef<string>("")
  const activeTotalSizeRef = useRef<number>(0)
  const activeEntryCountRef = useRef<number>(1)
  const activeChunkCountRef = useRef<number>(1)

  // Sliding-window rate samples + transfer timer (mirror Android refs).
  const rateSamplesRef = useRef<RateSample[]>([])
  const transferStartMsRef = useRef<number>(0)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recvWorkerRef = useRef<Worker | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const jobIdRef = useRef<number>(0)
  const rafRef = useRef<number | null>(null)
  // QR decode worker pool (parallel frame decode). Each worker has a busy flag.
  const qrWorkersRef = useRef<Worker[]>([])
  const qrBusyRef = useRef<boolean[]>([])
  const firstFrameLoggedRef = useRef<boolean>(false)
  // Capture fps sliding window (timestamps of recent captureLoop runs).
  const frameTimesRef = useRef<number[]>([])
  const captureFpsRef = useRef<number>(0)
  // Guards the capture loop. teardown/reset set it false so a still-scheduled
  // RVFC/rAF callback from a previous session stops instead of running a second,
  // overlapping loop (which made re-scan "hard to find a code").
  const scanningActiveRef = useRef<boolean>(false)
  const framesDecodedRef = useRef<number>(0)
  const framesDroppedRef = useRef<number>(0)
  // Total QR symbols decoded (one per decoded payload) — drives decodePerSec,
  // mirroring Android's QrDecodePool.decodedCount().
  const decodedCodesRef = useRef<number>(0)
  const stageRef = useRef<Stage>("camera")
  const assemblingRef = useRef<boolean>(false)
  // Last wall-clock time recordPartialTransfer ran (throttled to 1/s).
  const lastPartialRecordRef = useRef<number>(0)
  // True while a capture callback (rVFC or rAF) is scheduled but has not yet
  // fired — prevents stacking a second concurrent loop when resupply re-arms
  // scanning while the previous chain's last callback is still pending.
  const framePendingRef = useRef<boolean>(false)
  // The pending requestVideoFrameCallback handle (rVFC has no global cancel;
  // the element's own cancelVideoFrameCallback must be used).
  const rvfcRef = useRef<number | null>(null)

  // keep stageRef in sync so the rAF loop can read the latest stage.
  useEffect(() => {
    stageRef.current = stage
  }, [stage])

  // Mirror the source choice for async callbacks (start button etc.).
  const sourceRef = useRef<ScanSourceKind>("camera")
  useEffect(() => {
    sourceRef.current = source
  }, [source])

  // Throttle capture-fps updates to the UI (every 500ms) while scanning.
  useEffect(() => {
    const id = setInterval(() => {
      setCaptureFps(captureFpsRef.current)
    }, 500)
    return () => clearInterval(id)
  }, [])

  /** Dev-only console trace (kept for debugging; not rendered in the UI). */
  const dbg = useCallback((msg: string) => {
    console.log(msg)
  }, [])

  /** Stop camera + workers + rAF. */
  const teardown = useCallback(() => {
    scanningActiveRef.current = false
    framePendingRef.current = false
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (rvfcRef.current !== null) {
      const video = videoRef.current as (HTMLVideoElement & {
        cancelVideoFrameCallback?: (handle: number) => void
      }) | null
      video?.cancelVideoFrameCallback?.(rvfcRef.current)
      rvfcRef.current = null
    }
    const stream = streamRef.current
    if (stream) {
      for (const t of stream.getTracks()) t.stop()
      streamRef.current = null
    }
    // Workers are terminated on full teardown / unmount; the pipeline restart
    // path reuses them across sessions.
  }, [])

  useEffect(() => {
    return () => {
      teardown()
      for (const w of qrWorkersRef.current) w.terminate()
      recvWorkerRef.current?.terminate()
    }
  }, [teardown])

  /** Attach a stream to the shared video element. */
  const attachStream = useCallback((stream: MediaStream) => {
    streamRef.current = stream
    const video = videoRef.current
    if (video) {
      video.srcObject = stream
    }
  }, [])

  /** Start the camera stream and attach it to the video element. */
  const startCamera = useCallback(async (): Promise<boolean> => {
    setStage("camera")
    stageRef.current = "camera"
    setError(null)
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
    try {
      const attempts: MediaStreamConstraints[] = [
        {
          video: {
            facingMode: "environment",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 60, max: 60 },
          },
          audio: false,
        },
        { video: { facingMode: "environment" }, audio: false },
        { video: true, audio: false },
      ]
      let stream: MediaStream | null = null
      let lastError: unknown = null
      for (const constraints of attempts) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints)
          break
        } catch (e) {
          lastError = e
        }
      }
      if (!stream) throw lastError ?? new Error("没有可用摄像头")
      attachStream(stream)
      await videoRef.current?.play()
      return true
    } catch (e) {
      setError(
        `无法访问摄像头：${e instanceof Error ? e.message : String(e)}。请确认已授予摄像头权限，并使用 HTTPS 或 localhost。`
      )
      stageRef.current = "error"
      setStage("error")
      return false
    }
  }, [attachStream])

  /**
   * Start screen/tab/window capture (desktop browsers). The browser picker
   * must be triggered from a user gesture — the 开始接收 click qualifies.
   * Only the frame rate is pinned; the resolution follows the captured
   * surface's native size (desktop surfaces are ≥1080p, plenty for QR).
   * Cancelling the picker stays on the entry screen (not an error).
   */
  const startDisplay = useCallback(async (): Promise<boolean> => {
    setStage("camera")
    stageRef.current = "camera"
    setError(null)
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 } },
        audio: false,
      })
      attachStream(stream)
      await videoRef.current?.play()
      // The browser's own "stop sharing" bar ends the track without throwing;
      // watch for it and drop back to the source-select screen. Later stages
      // (recovering/done) no longer depend on the stream, so ignore it there.
      const track = stream.getVideoTracks()[0]
      if (track) {
        track.onended = () => {
          if (stageRef.current === "scanning" || stageRef.current === "camera") {
            teardown()
            setStage("camera")
            stageRef.current = "camera"
          }
        }
      }
      return true
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotAllowedError") {
        // User dismissed the picker — quietly stay on the entry screen.
        return false
      }
      setError(
        `无法开始屏幕捕获：${e instanceof Error ? e.message : String(e)}。请使用支持屏幕共享的桌面浏览器（HTTPS 或 localhost）。`
      )
      stageRef.current = "error"
      setStage("error")
      return false
    }
  }, [attachStream, teardown])

  /** Start whichever source the user picked on the entry screen. */
  const startSelectedSource = useCallback(async (): Promise<boolean> => {
    return sourceRef.current === "display" ? startDisplay() : startCamera()
  }, [startDisplay, startCamera])

  /**
   * Merge a worker `status` message into the UI progress state. Computes the
   * sliding-window decode rate + wire throughput and the derived pct/statusText
   * exactly like Android ScanActivity.
   *
   * NOTE: this MUST be declared before `initWorkers`, which references it in
   * its useCallback deps (a `const` referenced in an earlier closure's deps
   * array is a TDZ error at render time).
   */
  const applyStatus = useCallback((d: Record<string, unknown>) => {
    const snap = d.snapshot as ProgressSnapshot | null
    const nowMs = (typeof d.nowMs === "number" ? d.nowMs : Date.now()) as number
    setProgress((prev) => {
      const p: ProgressInfo = { ...prev }
      p.complete = !!d.complete
      p.framesDropped = framesDroppedRef.current
      p.framesSeen = framesDecodedRef.current
      if (snap) {
        p.receivedSymbols = snap.receivedSymbols
        p.totalSymbols = snap.totalSymbols
        p.decodedSymbols = snap.decodedSymbols
        p.decodedBlocks = snap.decodedBlocks
        p.totalBlocks = snap.totalBlocks
        p.decodedFraction = snap.decodedFraction
        p.metaConfirmed = snap.metaConfirmed
        p.symbolSize = snap.symbolSize
        p.legacyPeerFrames = snap.legacyPeerFrames || 0
        if (snap.fileName) {
          p.fileName = snap.fileName
          activeNameRef.current = snap.fileName
        }
        const rawSz = snap.fileSize ?? snap.totalRawSize
        if (rawSz && rawSz > 0) {
          p.fileSize = rawSz
          activeTotalSizeRef.current = rawSz
        }
        if (snap.transferIdHex) {
          activeTransferIdRef.current = snap.transferIdHex
        }
        if (snap.entryCount) {
          activeEntryCountRef.current = snap.entryCount
        }
        if (snap.chunkCount) {
          activeChunkCountRef.current = snap.chunkCount
        }
      }

      // Sliding-window rates (matches Android: prune stale samples, derive
      // Δcount/Δt with a min-dt guard). decodePerSec uses decoded QR symbols
      // (decodedCodesRef), NOT RaptorQ decoded_symbols — those jump whole blocks
      // and sit at 0 most of the time, exactly why Android uses decodedCount().
      const receivedNow = p.receivedSymbols
      const decodedNow = decodedCodesRef.current
      const framesNow = framesDecodedRef.current
      const symbolSize = Math.max(1, p.symbolSize)
      if (p.complete) {
        p.decodePerSec = 0
        p.recentWireBps = 0
        p.avgCodesPerFrame = 0
        rateSamplesRef.current = []
      } else if (receivedNow > 0 || decodedNow > 0) {
        const samples = rateSamplesRef.current
        samples.push({ tMs: nowMs, decoded: decodedNow, receivedSymbols: receivedNow, frames: framesNow })
        while (samples.length > 1 && nowMs - samples[0].tMs > RATE_WINDOW_MS) {
          samples.shift()
        }
        if (samples.length >= 2) {
          const oldest = samples[0]
          const newest = samples[samples.length - 1]
          const dt = newest.tMs - oldest.tMs
          if (dt >= RATE_MIN_DT_MS) {
            p.decodePerSec = Math.max(
              0,
              Math.floor(((newest.decoded - oldest.decoded) * 1000) / dt)
            )
            const dSym = Math.max(0, newest.receivedSymbols - oldest.receivedSymbols)
            p.recentWireBps = Math.max(0, Math.floor((dSym * symbolSize * 1000) / dt))
            // Avg decoded codes per frame over the SAME 3s window (Δcodes/Δframes),
            // so it reflects the recent per-frame rate, not the whole session.
            const dFrames = newest.frames - oldest.frames
            p.avgCodesPerFrame = dFrames > 0
              ? Math.max(0, (newest.decoded - oldest.decoded) / dFrames)
              : 0
          }
        } else {
          // Window collapsed after a stall — don't show a stale rate.
          p.decodePerSec = 0
          p.recentWireBps = 0
          p.avgCodesPerFrame = 0
        }
      }

      // Transfer timer starts on first confirmed total.
      if (p.totalSymbols > 0 && transferStartMsRef.current === 0) {
        transferStartMsRef.current = nowMs
      }
      p.transferElapsedMs =
        transferStartMsRef.current > 0 ? nowMs - transferStartMsRef.current : 0

      // Derived progress bar + status text.
      p.progressPct = computePct(
        p.complete,
        p.metaConfirmed,
        p.totalSymbols,
        p.receivedSymbols
      )
      p.statusText = computeStatusText(
        p.complete,
        p.metaConfirmed,
        p.totalSymbols,
        p.receivedSymbols,
        p.decodedBlocks,
        p.progressPct,
        p.legacyPeerFrames
      )
      return p
    })
  }, [])

  /** Initialize both workers and wire up their message handlers. */
  const initWorkers = useCallback(async (): Promise<boolean> => {
    // Re-init (e.g. "再接收一次") must terminate the previous pool + receive
    // worker, or every retry leaks N qr workers (zxing WASM) + a receive worker.
    for (const w of qrWorkersRef.current) w.terminate()
    qrWorkersRef.current = []
    qrBusyRef.current = []
    recvWorkerRef.current?.terminate()
    // Receive worker (single; ingest stays serialized).
    const recv = createReceiveWorker()
    recvWorkerRef.current = recv

    const recvReady = new Promise<void>((resolve, reject) => {
      const h = (e: MessageEvent) => {
        if (e.data?.type === "ready" || e.data?.type === "init_ok") {
          recv.removeEventListener("message", h)
          resolve()
        } else if (e.data?.type === "error") {
          recv.removeEventListener("message", h)
          reject(new Error(e.data?.message || "receive worker 初始化失败"))
        }
      }
      recv.addEventListener("message", h)
      // A module-level load failure (404 / CSP / parse error) fires the
      // Worker "error" EVENT, not a message — without this the barrier below
      // would hang forever on a stage that never reports anything.
      const onFatal = (ev: ErrorEvent) => {
        recv.removeEventListener("message", h)
        reject(new Error(`receive worker 加载失败: ${ev.message || "未知错误"}`))
      }
      recv.addEventListener("error", onFatal)
    })
    // QR decode worker pool: N independent zxing workers → parallel frame decode.
    //
    // Each slot is created & wired by `spawnQrWorker(i)`. On a worker-level
    // "error" event (abnormal termination: uncaught exception, OOM,
    // module-load failure) the dead worker is **replaced** with a
    // fresh one and re-initialized — merely clearing the busy flag would let
    // captureLoop redispatch a frame to a dead worker that never replies,
    // permanently wedging that slot; repeated crashes would then shrink the
    // effective pool to 0 and capture stalls. Replacing keeps the pool at full
    // size and degrades only the few frames lost around each crash.
    const qrWorkers: Worker[] = new Array(QR_WORKER_POOL)
    const qrReadyAll: Promise<void>[] = []
    const readyResolvers: (() => void)[] = new Array(QR_WORKER_POOL)
    const readyRejecters: ((reason: Error) => void)[] = new Array(QR_WORKER_POOL)
    // Consecutive fatal failures per slot without an intervening "ready".
    // If the worker script/wasm can't load at all, every replacement dies
    // instantly — without a cap that becomes an infinite respawn loop.
    const qrSpawnFails: number[] = new Array(QR_WORKER_POOL).fill(0)
    for (let i = 0; i < QR_WORKER_POOL; i++) {
      qrReadyAll.push(
        new Promise<void>((resolve, reject) => {
          readyResolvers[i] = resolve
          readyRejecters[i] = reject
        })
      )
    }

    /**
     * Create (or replace) the qr worker at slot `i`, wire ALL of its handlers,
     * and send it `init`. Returns the new worker. `qrWorkersRef.current[i]` is
     * updated so captureLoop dispatches to the live worker. When `trackReady`
     * is set, this worker's "ready" resolves the init barrier (used only for
     * the initial pool); replacement workers restore themselves asynchronously
     * without blocking capture.
     */
    const spawnQrWorker = (i: number, trackReady: boolean): Worker => {
      const qr = createQrWorker()
      qrWorkers[i] = qr
      qrWorkersRef.current[i] = qr
      // Held busy until this worker reports ready, so captureLoop never
      // dispatches a frame to a not-yet-initialized (replacement) worker.
      qrBusyRef.current[i] = true

      qr.addEventListener("message", (e: MessageEvent) => {
        const d = e.data
        if (!d) return
        if (d.type === "ready") {
          qrBusyRef.current[i] = false
          qrSpawnFails[i] = 0
          if (trackReady) readyResolvers[i]()
          dbg(`[qr#${i}] READY ✓`)
          return
        }
        if (d.type === "decoded") {
          qrBusyRef.current[i] = false
          const n = Array.isArray(d.payloads) ? d.payloads.length : 0
          if (n > 0) {
            framesDecodedRef.current += 1
            decodedCodesRef.current += n
            // 采样日志：每 10 帧打一次，避免刷屏
            if (framesDecodedRef.current % 10 === 1) {
              dbg(`[qr#${i}] decoded #${framesDecodedRef.current}: ${n} payload(s)`)
            }
            recv.postMessage({
              type: "ingest",
              frames: d.payloads,
              jobId: jobIdRef.current,
            })
          }
        } else if (d.type === "error") {
          qrBusyRef.current[i] = false
          dbg(`[qr#${i}] decode error: ${d.message}`)
        }
      })

      // Per-worker fatal error: replace the dead worker so the slot keeps
      // working. Guard against double-replacement (the same worker firing
      // "error" more than once) by checking it is still the live one.
      // `trackReady` stays true: if the crash happens before the initial init
      // barrier completes, the replacement's "ready" must still resolve the
      // barrier; if it happens at runtime, the resolver is already resolved and
      // re-resolving is a harmless no-op. More than 3 consecutive deaths
      // without a ready means the worker assets themselves are broken — stop
      // respawning (or the loop burns CPU forever) and fail the barrier.
      const onSlotDeath = (reason: string): void => {
        if (qrWorkersRef.current[i] !== qr) return
        qrSpawnFails[i] += 1
        qr.terminate()
        if (qrSpawnFails[i] > 3) {
          dbg(`[qr#${i}] giving up after ${qrSpawnFails[i]} consecutive failures (${reason})`)
          readyRejecters[i]?.(
            new Error(`二维码解码 worker 连续失败（${reason}），请刷新页面重试`)
          )
          return
        }
        dbg(`[qr#${i}] replacing dead worker (${reason})...`)
        spawnQrWorker(i, trackReady)
      }
      qr.addEventListener("error", (ev) => {
        dbg(`[qr#${i}] WORKER ERROR: ${ev.message || ""} @${ev.filename}:${ev.lineno}`)
        onSlotDeath(ev.message || "worker error")
      })
      // A reply whose structured-clone deserialization failed never arrives:
      // leaving the slot busy wedges it forever (effective pool -1 per
      // occurrence), and the worker's state after the failed deserialization
      // is unknown — so recover exactly like the fatal "error" event:
      // terminate + replace (the replacement holds its slot busy until it
      // reports ready, so captureLoop never dispatches to it prematurely).
      qr.addEventListener("messageerror", (ev) => {
        dbg(`[qr#${i}] MESSAGE ERROR: ${String(ev.data || "")}`)
        onSlotDeath("message error")
      })
      // Kick off this worker's initialization. Sending here (rather than in the
      // caller) guarantees both the initial pool and error-path replacements
      // always get their init — forgetting it leaves the slot busy forever and
      // the init barrier times out.
      qr.postMessage({ type: "init" })
      return qr
    }

    for (let i = 0; i < QR_WORKER_POOL; i++) spawnQrWorker(i, true)
    const qrReady = Promise.all(qrReadyAll)

    // 捕获 worker 级错误（脚本解析失败 / 未捕获异常 / message 反序列化失败）
    recv.addEventListener("error", (ev) =>
      dbg(`[recv] WORKER ERROR: ${ev.message || ""} @${ev.filename}:${ev.lineno}`)
    )
    recv.addEventListener("messageerror", (ev) =>
      dbg(`[recv] MESSAGE ERROR: ${String(ev.data || "")}`)
    )

    // (The AF2 receive worker decompresses chunks inside the Rust WASM
    // instance — no zstd WASM preload message exists anymore.)
    jobIdRef.current += 1
    recv.postMessage({ type: "init", jobId: jobIdRef.current })
    // (Each qr worker's `init` was already sent by `spawnQrWorker`.)
    dbg(`[init] init sent to receive worker + ${qrWorkers.length} qr workers; waiting for ready...`)

    try {
      // A worker that never reports (hangs during wasm init) must not wedge
      // the stage at "scanning" with no capture loop and no error.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("worker 初始化超时（15 秒）")), 15_000)
      )
      await Promise.race([
        Promise.all([
          recvReady.then(() => dbg("[init] receive worker READY ✓")),
          qrReady.then(() => dbg("[init] qr worker pool READY ✓")),
        ]),
        timeout,
      ])
    } catch (e) {
      dbg(`[init] FAILED: ${e instanceof Error ? e.message : String(e)}`)
      setError(
        `Worker 初始化失败：${e instanceof Error ? e.message : String(e)}。刷新重试。`
      )
      setStage("error")
      stageRef.current = "error"
      return false
    }
    dbg(`[init] receive worker + ${qrWorkers.length} qr workers READY ✓`)
    // (Each qr worker's decoded/error forwarding + fatal-error replacement is
    // already wired inside `spawnQrWorker` above.)

    // Wire receive worker → UI (status / meta / result / error).
    recv.addEventListener("message", (e: MessageEvent) => {
      const d = e.data
      if (!d) return
      if (d.jobId !== undefined && d.jobId !== jobIdRef.current) return // stale
      if (d.type === "status") {
        if (d.complete && !assemblingRef.current) {
          assemblingRef.current = true
          dbg("[recv] COMPLETE → assemble")
          stageRef.current = "recovering"
          setStage((s) => (s === "scanning" ? "recovering" : s))
          recv.postMessage({ type: "assemble", jobId: jobIdRef.current })
        }
        if (activeTransferIdRef.current) {
          // Throttle: status arrives per ingest batch (tens per second) and
          // recordPartialTransfer does a full localStorage parse+stringify of
          // the whole history array each call — at batch rate that stalls the
          // frame loop once the history holds a large item.
          const now = Date.now()
          if (now - lastPartialRecordRef.current >= 1000) {
            lastPartialRecordRef.current = now
            recordPartialTransfer(
              activeTransferIdRef.current,
              activeNameRef.current,
              activeTotalSizeRef.current,
              activeEntryCountRef.current,
              Number(d.decodedBlocks) || 0,
              Number(d.totalBlocks) || activeChunkCountRef.current,
              activeEntryCountRef.current > 1 ? "bundle" : "file"
            )
          }
        }
        applyStatus(d as Record<string, unknown>)
      } else if (d.type === "meta") {
        const m = (d.meta || d) as {
          fileName?: string
          fileSize?: number
          originalSize?: number
          compressedSize?: number
          compressedSizeKnown?: boolean
          rootId?: string
          transferIdHex?: string
          totalRawSize?: number
          entryCount?: number
          chunkCount?: number
        } | null
        const sz = m?.totalRawSize ?? m?.fileSize ?? m?.originalSize
        const tid = m?.transferIdHex || ""
        const fn = m?.fileName
        if (fn) activeNameRef.current = fn
        if (sz) activeTotalSizeRef.current = sz
        if (m?.entryCount) activeEntryCountRef.current = m.entryCount
        if (m?.chunkCount) activeChunkCountRef.current = m.chunkCount
        if (tid) {
          activeTransferIdRef.current = tid
          recordPartialTransfer(
            tid,
            activeNameRef.current,
            activeTotalSizeRef.current,
            activeEntryCountRef.current,
            0,
            m?.chunkCount || 1,
            (m?.entryCount || 1) > 1 ? "bundle" : "file"
          )
        }
        setProgress((p) => ({
          ...p,
          fileName: fn ?? p.fileName,
          fileSize: sz ?? p.fileSize,
          compressedSize: m?.compressedSize ?? p.compressedSize,
          compressedSizeKnown: m?.compressedSizeKnown ?? p.compressedSizeKnown,
        }))
      } else if (d.type === "warn") {
        dbg(`[recv] warn: ${d.message}`)
      } else if (d.type === "resupply") {
        // Assembly found only local spill corruption/missing chunks. The
        // worker kept the session + good OPFS chunks and invalidated the bad
        // indices, so resume scanning instead of entering the fatal error path
        // (whose Reset button intentionally destroys resume state).
        dbg(`[recv] resupply: ${d.message}`)
        assemblingRef.current = false
        stageRef.current = "scanning"
        setStage("scanning")
        setError(null)
        setProgress((p) => ({ ...p, statusText: d.message || "等待损坏分块重供…" }))
        // The existing capture loop may have returned while stage=recovering;
        // explicitly kick one new frame now that scanning is re-armed.
        scheduleNextFrame()
      } else if (d.type === "relock") {
        // The Rust receiver re-locked onto a different transfer: drop the
        // previous transfer's name/progress display until the new manifest
        // arrives (otherwise the UI keeps showing stale data with no hint).
        dbg("[recv] relocked to a new transfer")
        activeTransferIdRef.current = ""
        activeNameRef.current = ""
        activeTotalSizeRef.current = 0
        activeEntryCountRef.current = 1
        setProgress((p) => ({
          ...initialProgress(),
          statusText: "检测到新传输，已切换…",
        }))
      } else if (d.type === "result") {
        dbg(`[recv] RESULT: ${d.recovered?.kind}`)
        const rec = d.recovered as Recovered
        const kind = rec?.kind || "file"
        const name =
          kind === "text"
            ? (rec as { name?: string }).name || "文字消息.txt"
            : kind === "file"
            ? (rec as { name: string }).name || activeNameRef.current || "received_file"
            : activeNameRef.current || "多文件传输包"
        setResult({
          recovered: rec,
          name,
        })
        const tid = activeTransferIdRef.current
        const textContent = kind === "text" ? (rec as { text: string }).text : undefined
        recordCompletedTransfer(
          tid,
          name,
          activeTotalSizeRef.current,
          activeEntryCountRef.current,
          kind,
          textContent
        )
        assemblingRef.current = false
        stageRef.current = "done"
        setStage("done")
        teardown()
      } else if (d.type === "error") {
        dbg(`[recv] error: ${d.message}`)
        setError(d.message)
        assemblingRef.current = false
        stageRef.current = "error"
        setStage("error")
        teardown()
      }
    })
    return true
  }, [teardown, dbg, applyStatus])

  /** The per-frame capture + decode loop (driven by requestVideoFrameCallback). */
  const captureLoop = useCallback(() => {
    framePendingRef.current = false
    if (!scanningActiveRef.current) return // a previous session's loop must die
    // Capture fps: count captureLoop runs in a 1s sliding window.
    const fpsNow = performance.now()
    const ft = frameTimesRef.current
    ft.push(fpsNow)
    while (ft.length > 0 && fpsNow - ft[0] > 1000) ft.shift()
    if (captureFpsRef.current !== ft.length) captureFpsRef.current = ft.length
    const video = videoRef.current
    const canvas = canvasRef.current
    const qrWorkers = qrWorkersRef.current
    if (!video || !canvas || qrWorkers.length === 0) return
    if (stageRef.current !== "scanning") return

    const srcW = video.videoWidth
    const srcH = video.videoHeight
    if (srcW === 0 || srcH === 0) {
      rafRef.current = requestAnimationFrame(captureLoop)
      return
    }
    // Pick the first free qr worker for parallel frame decode. If all are busy
    // (decoding previous frames), drop this frame (back-pressure) — the pool
    // keeps N frames in flight across cores, so this is far less lossy than a
    // single worker.
    const freeIdx = qrBusyRef.current.findIndex((b) => !b)
    if (freeIdx === -1) {
      framesDroppedRef.current += 1
      scheduleNextFrame()
      return
    }
    // Never downscale (keep QR cells large & crisp). DECODE_MAX_WIDTH is a
    // safety cap only for absurd cameras (>0 enables it); default 0 = native.
    const w = DECODE_MAX_WIDTH > 0 && DECODE_MAX_WIDTH < srcW
      ? Math.max(1, Math.round(srcW * (DECODE_MAX_WIDTH / srcW)))
      : srcW
    const h = w === srcW ? srcH : Math.max(1, Math.round(srcH * (w / srcW)))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    // 首帧打一次日志，确认取帧尺寸正常（只打一次，避免静默扫描时刷屏）
    if (!firstFrameLoggedRef.current) {
      firstFrameLoggedRef.current = true
      dbg(
        `[capture] first frame: ${srcW}×${srcH} → decode ${w}×${h} ` +
          `(pool=${qrWorkers.length}, backend=fast Y)`
      )
    }
    qrBusyRef.current[freeIdx] = true
    // FAST-only: feed the Y (luminance) plane directly (no RGBA conversion).
    const yPlane = extractYPlane(video, canvas, w, h)
    if (!yPlane) {
      // Extraction failed — drop this frame rather than misroute a decode.
      qrBusyRef.current[freeIdx] = false
      framesDroppedRef.current += 1
      scheduleNextFrame()
      return
    }
    qrWorkers[freeIdx].postMessage(
      {
        type: "decode",
        width: w,
        height: h,
        format: "Y",
        yPlane,
        jobId: jobIdRef.current,
      },
      [yPlane.buffer]
    )
    // Each worker's decoded handler (wired in initWorkers) marks it free again
    // and forwards payloads to the receive worker; just refresh frame counters.
    // busy cleared by that handler.
    setProgress((p) => ({
      ...p,
      framesSeen: framesDecodedRef.current,
      framesDropped: framesDroppedRef.current,
    }))
    scheduleNextFrame()
  }, [])

  /** Schedule the next capture via rVFC if available, else rAF. */
  const scheduleNextFrame = useCallback(() => {
    // One in-flight callback at a time: resupply re-arms scanning while the
    // previous chain's last callback may still be pending — scheduling again
    // would run two concurrent capture loops (double decode per frame).
    if (framePendingRef.current) return
    framePendingRef.current = true
    const video = videoRef.current
    if (!video) {
      rafRef.current = requestAnimationFrame(captureLoop)
      return
    }
    // requestVideoFrameCallback fires on actual decoded video frames (best for
    // video). Fall back to rAF where unsupported (older Safari).
    const rvfc = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number
      }
    ).requestVideoFrameCallback
    if (typeof rvfc === "function") {
      rvfcRef.current = rvfc.call(video, () => captureLoop())
    } else {
      rafRef.current = requestAnimationFrame(captureLoop)
    }
  }, [captureLoop])

  /** Start scanning: init workers, begin capture loop. */
  const startScanning = useCallback(async () => {
    stageRef.current = "scanning"
    setStage("scanning")
    setError(null)
    scanningActiveRef.current = true
    framesDecodedRef.current = 0
    framesDroppedRef.current = 0
    decodedCodesRef.current = 0
    rateSamplesRef.current = []
    transferStartMsRef.current = 0
    firstFrameLoggedRef.current = false
    setProgress(initialProgress())
    assemblingRef.current = false
    const initialized = await initWorkers()
    if (!initialized) {
      scanningActiveRef.current = false
      return false
    }
    // Begin the capture loop on the next frame.
    scheduleNextFrame()
    return true
  }, [initWorkers, scheduleNextFrame])

  /** Reset to scan again (new session). */
  const reset = useCallback(() => {
    teardown()
    assemblingRef.current = false
    jobIdRef.current += 1
    recvWorkerRef.current?.postMessage({ type: "reset", jobId: jobIdRef.current })
    rateSamplesRef.current = []
    transferStartMsRef.current = 0
    setResult(null)
    setError(null)
    stageRef.current = "camera"
    setStage("camera")
  }, [teardown])

  return (
    <div className="app receive-page">
      <header className="app-header receive-header">
        <div className="app-logo">
          <img src={iconUrl} alt="AirFerry" />
        </div>
        <div className="app-title">
          <h1>AirFerry 接收端</h1>
        </div>
        <div className="header-right-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setHistoryOpen(true)}
            title="查看接收历史与断点任务"
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
          >
            <HistoryIcon size={16} />
            <span>历史与断点</span>
          </button>
        </div>
      </header>

      <main className="app-main">
        <div className="receive-native-hint" role="note">
          <span className="hint-icon" aria-hidden="true">
            <WarningIcon size={16} />
          </span>
          <span>
            网页版接收端受浏览器摄像头与解码性能限制，速度明显低于原生端。
            追求满速、稳定的大文件恢复，建议使用 Android 或 Windows 原生接收端。
          </span>
        </div>
        <div className="receive-stage">
          {(stage === "camera" || stage === "scanning" || stage === "recovering") && (
            <div className="camera-area">
              {/* Display capture previews with contain: cover would crop QR
                  codes living at the screen edges (frames are extracted at
                  native videoWidth/Height via canvas, so CSS never affects
                  decoding — this is preview-only). */}
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`camera-video${source === "display" ? " contain" : ""}`}
              />
              <canvas ref={canvasRef} style={{ display: "none" }} />
              {stage === "camera" && (
                <div className="source-select">
                  <button
                    type="button"
                    className={`source-option${source === "camera" ? " selected" : ""}`}
                    onClick={() => setSource("camera")}
                  >
                    <span className="source-option-title">摄像头</span>
                    <span className="source-option-desc">用手机或电脑摄像头对准屏幕上的二维码</span>
                  </button>
                  {displaySupported && (
                    <button
                      type="button"
                      className={`source-option${source === "display" ? " selected" : ""}`}
                      onClick={() => setSource("display")}
                    >
                      <span className="source-option-title">屏幕捕获</span>
                      <span className="source-option-desc">直接捕获本机的屏幕 / 标签页 / 窗口（桌面浏览器）</span>
                    </button>
                  )}
                </div>
              )}
              {stage === "scanning" && (
                <div className="fps-badge">{captureFps} fps</div>
              )}
            </div>
          )}

          {stage === "camera" && (
            <div className="receive-actions">
              <button
                onClick={async () => {
                  if (await startSelectedSource()) await startScanning()
                }}
                className="btn primary"
              >
                开始接收
              </button>
            </div>
          )}

          {(stage === "scanning" || stage === "recovering") && (
            <ScanProgress progress={progress} />
          )}

          {stage === "done" && result && (
            <ResultView result={result} onReset={reset} />
          )}

          {stage === "error" && (
            <div className="error-area">
              <p className="error-msg">
                <ErrorIcon size={16} />
                <span>{error}</span>
              </p>
              <button onClick={reset} className="btn primary">
                重试
              </button>
            </div>
          )}
        </div>
      </main>

      <footer className="app-footer">
        <span className="app-footer-hint">AirFerry · 无网文件传输</span>
      </footer>

      <HistoryModal isOpen={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  )
}



/**
 * The scan-time progress panel. Uses a horizontal bar (not a ring) so the
 * parameter card below stays visible while scanning — a ring crowds it out.
 */
function ScanProgress({
  progress,
}: {
  progress: ProgressInfo
}): React.ReactElement {
  const wireTotal = progress.totalSymbols * Math.max(1, progress.symbolSize)
  const showOrig = progress.fileSize > 0
  const showWire = wireTotal > 0 && progress.symbolSize > 0
  let sizeStr = ""
  if (showOrig || showWire) {
    if (showOrig) {
      sizeStr += formatSize(progress.fileSize)
      if (showWire) sizeStr += "~压缩后 "
    }
    if (showWire) sizeStr += formatSize(wireTotal)
  }
  const speedStr =
    progress.recentWireBps > 0 ? formatSize(progress.recentWireBps) + "/s" : ""
  const elapsedStr =
    progress.transferElapsedMs > 0
      ? formatDuration(progress.transferElapsedMs)
      : ""
  const hasMeta = progress.metaConfirmed || progress.totalSymbols > 0

  return (
    <div className="progress-area">
      {/* Horizontal bar + big percentage (visible at a glance). */}
      <div className="progress-header">
        <div className="progress-track-lg">
          <div
            className="progress-bar"
            style={{ width: `${progress.progressPct}%` }}
          />
        </div>
        <div className="progress-pct-lg">{progress.progressPct}%</div>
      </div>

      {/* Parameter card — always shown; values fill in as meta arrives. */}
      <div className="progress-card">
        {progress.fileName !== "" ? (
          <div className="progress-file-name">{progress.fileName}</div>
        ) : (
          <div className="progress-file-name progress-file-name-placeholder">
            等待识别二维码…
          </div>
        )}
        <div className="progress-row">
          <span className="progress-label">大小</span>
          <span className="progress-value">
            {sizeStr !== "" ? sizeStr : "—"}
          </span>
        </div>
        <div className="progress-row">
          <span className="progress-label">已识别符号</span>
          <span className="progress-value">
            {hasMeta
              ? `${progress.receivedSymbols} / ${progress.totalSymbols}`
              : "—"}
          </span>
        </div>
        <div className="progress-row">
          <span className="progress-label">解码速率</span>
          <span className="progress-value">
            {progress.decodePerSec > 0 ? `${progress.decodePerSec} 符号/秒` : "—"}
          </span>
        </div>
        <div className="progress-row">
          <span className="progress-label">每帧码数</span>
          <span className="progress-value">
            {progress.avgCodesPerFrame > 0
              ? `${progress.avgCodesPerFrame.toFixed(1)} 码/帧`
              : "—"}
          </span>
        </div>
        <div className="progress-row">
          <span className="progress-label">用时</span>
          <span className="progress-value">
            {elapsedStr !== ""
              ? speedStr !== ""
                ? `${elapsedStr} @ ${speedStr}`
                : elapsedStr
              : "—"}
          </span>
        </div>
      </div>
    </div>
  )
}

/** Render the recovered payload (text / file / bundle) with save/copy actions. */
function ResultView({
  result,
  onReset,
}: {
  result: ResultInfo
  onReset: () => void
}): React.ReactElement {
  const { recovered } = result
  return (
    <div className="result-area">
      <h2>
        <CheckCircleIcon size={20} /> 接收完成
      </h2>
      <p className="crc-status">
        {/* Every chunk and the manifest were BLAKE3-verified inside the Rust
            receiver before acceptance — that is the verification that ran on
            this path (there is no separate whole-stream CRC). */}
        <CheckIcon size={14} /> 分块完整性校验通过（BLAKE3）
      </p>
      {recovered.kind === "text" && (
        <TextView
          name={result.name}
          text={recovered.text}
          valid={recovered.validUtf8}
        />
      )}
      {recovered.kind === "file" && (
        <FileView
          name={result.name || "received_file"}
          data={recovered.data}
        />
      )}
      {recovered.kind === "bundle" && (
        <BundleView
          title={result.name}
          entries={recovered.entries}
        />
      )}
      <button onClick={onReset} className="btn primary">
        再接收一次
      </button>
    </div>
  )
}

function TextView({
  name,
  text,
  valid,
}: {
  name?: string
  text: string
  valid: boolean
}): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const displayName = name || "文字消息.txt"
  const onCopy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        // Clipboard permission denied / document not focused — surface it on
        // the button instead of an unhandled rejection.
        setCopied(false)
        alert("复制失败：浏览器未授权剪贴板，请手动选择文本复制。")
      })
  }
  const onSave = () => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = displayName
    a.click()
    // Firefox cancels the download if the URL is revoked synchronously.
    revokeDownloadUrlLater(url)
  }
  return (
    <div className="text-result">
      <div className="file-result-header" style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", fontWeight: 600, fontSize: "14px" }}>
        <TextDocIcon size={16} />
        <span className="file-result-name">{displayName}</span>
      </div>
      {!valid && (
        <p className="warn">
          <WarningIcon size={14} /> 文本包含无效 UTF-8，已尽力解码
        </p>
      )}
      {text.length <= 2 * 1024 * 1024 ? (
        <pre className="text-content">{text}</pre>
      ) : (
        <p className="warn">文本过长（{text.length} 字符），未全文渲染</p>
      )}
      <div className="receive-actions">
        <button onClick={onCopy} className="btn">
          {copied ? "已复制" : "复制"}
        </button>
        <button onClick={onSave} className="btn">
          保存为 .txt
        </button>
      </div>
    </div>
  )
}

function FileView({
  name,
  data,
}: {
  name: string
  data: Blob
}): React.ReactElement {
  const onDownload = () => {
    const url = URL.createObjectURL(data)
    const a = document.createElement("a")
    a.href = url
    a.download = name
    a.click()
    // Firefox cancels the download if the URL is revoked synchronously.
    revokeDownloadUrlLater(url)
  }
  const sizeKiB = (data.size / 1024).toFixed(1)
  return (
    <div className="file-result">
      <p>
        <FileIcon size={16} />
        <span className="file-result-name">
          {name}（{sizeKiB} KiB）
        </span>
      </p>
      <button onClick={onDownload} className="btn primary">
        下载
      </button>
    </div>
  )
}

function BundleView({
  title,
  entries,
}: {
  title?: string
  entries: { name: string; data: Blob }[]
}): React.ReactElement {
  const [zipError, setZipError] = useState("")
  const onDownloadZip = async () => {
    setZipError("")
    let zipBlob: Blob
    try {
      zipBlob = await createZipBlob(entries)
    } catch (e) {
      // createZipBlob streams entry data (CRC pass) — an OPFS-backed entry
      // whose backing file disappeared rejects here. Surface it instead of
      // failing as an unhandled rejection with a silently dead button.
      setZipError(
        `打包失败：${e instanceof Error ? e.message : String(e)}。请尝试逐个下载，或重新接收后再下载。`
      )
      return
    }
    const url = URL.createObjectURL(zipBlob)
    const a = document.createElement("a")
    a.href = url
    const dateStr = new Date().toISOString().slice(0, 10)
    a.download = `AirFerry-文件包-${dateStr}.zip`
    a.click()
    revokeDownloadUrlLater(url)
  }

  const onDownloadAll = () => {
    for (const e of entries) {
      const url = URL.createObjectURL(e.data)
      const a = document.createElement("a")
      a.href = url
      a.download = e.name
      a.click()
      revokeDownloadUrlLater(url)
    }
  }

  return (
    <div className="bundle-result">
      <div className="file-result-header" style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: 600, fontSize: "14px" }}>
        <PackageIcon size={16} />
        <span className="file-result-name">{title || `多文件传输包（${entries.length} 个文件）`}</span>
      </div>
      <ul className="bundle-list">
        {entries.map((e, i) => {
          const onDownload = () => {
            const url = URL.createObjectURL(e.data)
            const a = document.createElement("a")
            a.href = url
            a.download = e.name
            a.click()
            revokeDownloadUrlLater(url)
          }
          return (
            <li key={i}>
              <span>
                {e.name}（{(e.data.size / 1024).toFixed(1)} KiB）
              </span>
              <button onClick={onDownload} className="btn btn-sm">
                下载
              </button>
            </li>
          )
        })}
      </ul>
      <div className="bundle-actions" style={{ display: "flex", gap: "10px", marginTop: "6px" }}>
        <button onClick={onDownloadZip} className="btn primary" style={{ flex: 2 }}>
          打包下载 (.zip)
        </button>
        <button onClick={onDownloadAll} className="btn" style={{ flex: 1 }}>
          逐个下载
        </button>
      </div>
      {zipError ? (
        <p className="bundle-zip-error" style={{ color: "#d33", fontSize: "12px", marginTop: "6px" }}>
          {zipError}
        </p>
      ) : null}
    </div>
  )
}

export default ReceivePage

