/**
 * Web receiver page — scan the sender's QR video stream and recover the
 * file/text/bundle.
 *
 * Pipeline (all off-main-thread where possible):
 *   camera (getUserMedia) or screen/tab capture (getDisplayMedia) → video element
 *     → requestVideoFrameCallback captures a frame
 *       → qr-decode.worker (fast ZXing-C++ WASM or zxing-wasm compat) decodes all QR payloads
 *         → receive.worker ingests them (serial; Rust receiver not thread-safe)
 *           → on complete: assemble_raw → JS decompress → CRC → parse
 *
 * The entry screen shows a source selector (camera / screen capture). The
 * screen option is hidden where getDisplayMedia is unavailable (mobile
 * browsers), leaving the camera-only UI exactly as before.
 */

import { useState, useCallback, useRef, useEffect } from "react"
import "@/assets/app.css"
import "@/assets/receive.css"
import iconUrl from "../../assets/receiver-icon128.png"
import { decompressAndVerify, MAX_DECOMPRESSED_BYTES } from "@/receive/decompress"
import { parseRecovered, type Recovered } from "@/receive/parse"
import { ensureWasm } from "@/wasm/loader"
import { preloadZstdBytes } from "@/wasm/zstdPreload"
import {
  deleteStoredTask,
  listStoredTasks,
  readStoredSegment,
  type StoredSegmentTask,
} from "@/receive/taskStore"

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
  /** Segments already recovered for a descriptor-v5 large transfer (0 when none). */
  segmentReceived: number
  /** Total segments of the current large transfer (0 when not segmented). */
  segmentCount: number
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
 * the zxing-wasm decode; a pool lets N frames be decoded in parallel across the
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

interface WritableFileLike {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

interface SaveFileHandleLike {
  createWritable(): Promise<WritableFileLike>
}

// Compressed-stream segment size (mirrors Rust `SEGMENT_RAW_BYTES`).
const MAX_OBJECT_BYTES = 32 * 1024 * 1024
const MAX_SYMBOL_SIZE = 65_528
const SEGMENT_RAW_BYTES = MAX_OBJECT_BYTES - MAX_SYMBOL_SIZE
const FALLBACK_BLOB_MAX_BYTES = 64 * 1024 * 1024

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

async function readVerifiedStoredSegment(
  task: StoredSegmentTask,
  index: number
): Promise<Uint8Array> {
  const bytes = await readStoredSegment(task.rootId, index)
  const offset = index * SEGMENT_RAW_BYTES
  const expectedLength = Math.min(
    SEGMENT_RAW_BYTES,
    task.compressedSize - offset
  )
  if (expectedLength <= 0 || bytes.byteLength !== expectedLength) {
    throw new Error(`已存分段 ${index + 1} 长度不一致，请重新恢复该段`)
  }
  const expectedHash = task.hashes[index]
  if (!expectedHash || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new Error(`已存分段 ${index + 1} 缺少完整性记录`)
  }
  const exact = bytes.slice().buffer as ArrayBuffer
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", exact))
  const actualHex = Array.from(actual, (b) => b.toString(16).padStart(2, "0")).join("")
  if (actualHex !== expectedHash) {
    throw new Error(`已存分段 ${index + 1} 的 SHA-256 校验失败，请重新恢复该段`)
  }
  return bytes
}

/** Concatenate every stored compressed segment (in order) into the full stream. */
async function readFullCompressedStream(task: StoredSegmentTask): Promise<Uint8Array> {
  const received = new Set(task.received)
  const out = new Uint8Array(task.compressedSize)
  let written = 0
  for (let i = 0; i < task.segmentCount; i++) {
    if (!received.has(i)) throw new Error(`恢复记录缺少分段 ${i + 1}`)
    const bytes = await readVerifiedStoredSegment(task, i)
    out.set(bytes, written)
    written += bytes.byteLength
  }
  if (written !== task.compressedSize) {
    throw new Error(`拼接压缩流大小 ${written} 与声明的 ${task.compressedSize} 不一致`)
  }
  return out
}

/**
 * Recover a completed durable task: concatenate the stored **compressed**
 * segments, decompress exactly once, then verify length + SHA-256 + CRC32 and
 * parse the result into text / bundle / single file.
 */
async function recoverStoredTask(task: StoredSegmentTask): Promise<Recovered> {
  if (
    task.state !== "complete" ||
    task.received.length !== task.segmentCount ||
    new Set(task.received).size !== task.segmentCount ||
    task.hashes.length !== task.segmentCount
  ) {
    throw new Error("任务尚未完整恢复")
  }
  if (!/^[0-9a-f]{64}$/.test(task.rootSha256)) {
    throw new Error("任务缺少整文件 SHA-256，不能安全导出")
  }
  if (task.rootOriginalSize > MAX_DECOMPRESSED_BYTES) {
    throw new Error(`原始大小超过接收上限，无法恢复`)
  }
  await ensureWasm()
  const compressedStream = await readFullCompressedStream(task)
  const verify = await decompressAndVerify(
    compressedStream,
    task.compression,
    task.rootOriginalSize,
    task.crc32,
    task.crc32Known
  )
  if (verify.crcKnown && !verify.crcOk) {
    throw new Error("整文件 CRC32 校验失败，拒绝导出")
  }
  if (verify.bytes.length !== task.rootOriginalSize) {
    throw new Error("解压后大小与原文件不一致，拒绝导出")
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", verify.bytes.slice().buffer as ArrayBuffer)
  )
  if (bytesToHex(digest) !== task.rootSha256) {
    throw new Error("整文件 SHA-256 校验失败，拒绝导出")
  }
  return parseRecovered(verify.bytes, task.fileName)
}

/** Save a completed durable task: decompress once, then write file(s)/text. */
async function saveStoredTask(task: StoredSegmentTask): Promise<void> {
  const recovered = await recoverStoredTask(task)

  if (recovered.kind === "text") {
    // Text is displayed in the UI by the caller (see handleSave); nothing to
    // download here. The caller decides whether to offer a file export.
    return
  }

  if (recovered.kind === "bundle") {
    // Bundle: save every file as an individual download (fallback), since the
    // browser cannot stream multiple files into one picker.
    for (const entry of recovered.entries) {
      downloadBytes(entry.name || "file", entry.data)
    }
    return
  }

  const file = recovered
  const picker = (window as unknown as {
    showSaveFilePicker?: (options: {
      suggestedName: string
    }) => Promise<SaveFileHandleLike>
  }).showSaveFilePicker
  if (picker) {
    const handle = await picker({ suggestedName: file.name || "received_file" })
    const writable = await handle.createWritable()
    try {
      await writable.write(file.data)
      await writable.close()
    } catch (e) {
      await writable.abort?.().catch(() => undefined)
      throw e
    }
    return
  }
  if (file.data.byteLength > FALLBACK_BLOB_MAX_BYTES) {
    throw new Error(
      `当前浏览器不支持流式保存；${formatSize(file.data.byteLength)} 文件请使用 Chrome/Edge 桌面版导出`
    )
  }
  downloadBytes(file.name || "received_file", file.data)
}

/** Trigger a single-file download from bytes (fallback path). */
function downloadBytes(name: string, data: Uint8Array): void {
  const copy = data.slice()
  const url = URL.createObjectURL(
    new Blob([copy.buffer as ArrayBuffer], { type: "application/octet-stream" })
  )
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Compact one-based missing ranges, e.g. "2、5–7、11". */
function missingSegmentSummary(task: StoredSegmentTask, maxRanges = 4): string {
  const have = new Set(task.received)
  const ranges: string[] = []
  let omitted = false
  for (let i = 0; i < task.segmentCount;) {
    if (have.has(i)) {
      i += 1
      continue
    }
    const start = i
    while (i + 1 < task.segmentCount && !have.has(i + 1)) i += 1
    const end = i
    if (ranges.length < maxRanges) {
      ranges.push(start === end ? String(start + 1) : `${start + 1}–${end + 1}`)
    } else {
      omitted = true
    }
    i += 1
  }
  return ranges.length === 0 ? "无" : `${ranges.join("、")}${omitted ? " 等" : ""}`
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
    segmentReceived: 0,
    segmentCount: 0,
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
  pct: number
): string {
  if (complete) return "✓ 文件恢复完成"
  if (!metaConfirmed && receivedSymbols > 0)
    return `⏳ 正在同步… 已缓存 ${receivedSymbols} 符号 (~${pct}%)`
  if (totalSymbols === 0) return "等待二维码…"
  if (receivedSymbols > 0 && decodedBlocks === 0)
    return `接收中… ${receivedSymbols}/${totalSymbols} 符号 (等待解码)`
  return `恢复中… ${pct}%`
}

interface ResultInfo {
  recovered: Recovered
  crcOk: boolean
  crcKnown: boolean
}

/** Progress fields shipped by receive.worker's status message. */
interface ProgressSnapshot {
  totalSymbols: number
  decodedSymbols: number
  receivedSymbols: number
  decodedBlocks: number
  totalBlocks: number
  decodedFraction: number
  framesSeen: number
  framesDuplicate: number
  framesCorrupt: number
  metaConfirmed: boolean
  symbolSize: number
  complete: boolean
}

/**
 * Single-file (standalone) build: under `file://` a worker cannot be loaded
 * from a separate script file, so the build inlines both worker sources (with
 * their WASM base64 constants already prepended) on `globalThis`. We start them
 * from Blob URLs as **module** workers — the worker chunks contain
 * `import.meta.url` and dynamic-import machinery, and Chromium supports module
 * Blob workers under `file://` (verified with Chrome).
 */
const standaloneGlobals = globalThis as {
  __AIRFERRY_STANDALONE__?: boolean
  __RECEIVE_WORKER_CODE__?: string
  __QR_WORKER_CODE__?: string
}

// Created once per page: QR workers are replaced on a fatal error, and
// re-creating a ~1.5 MB Blob for every replacement is pointless.
let standaloneReceiveUrl: string | null = null
let standaloneQrUrl: string | null = null

function standaloneWorkerUrl(code: string, slot: "receive" | "qr"): string {
  const cached = slot === "receive" ? standaloneReceiveUrl : standaloneQrUrl
  if (cached) return cached
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
  if (slot === "receive") standaloneReceiveUrl = url
  else standaloneQrUrl = url
  return url
}

/**
 * Spawn the receive worker. Vite recognizes the `new URL("./...", import.meta.url)`
 * literal and emits the worker as a chunk.
 */
function createReceiveWorker(): Worker {
  if (
    standaloneGlobals.__AIRFERRY_STANDALONE__ &&
    standaloneGlobals.__RECEIVE_WORKER_CODE__
  ) {
    return new Worker(
      standaloneWorkerUrl(standaloneGlobals.__RECEIVE_WORKER_CODE__, "receive"),
      { type: "module" }
    )
  }
  return new Worker(new URL("../workers/receive.worker.ts", import.meta.url), {
    type: "module",
  })
}

/** Spawn the QR decode worker. */
function createQrWorker(): Worker {
  if (
    standaloneGlobals.__AIRFERRY_STANDALONE__ &&
    standaloneGlobals.__QR_WORKER_CODE__
  ) {
    return new Worker(
      standaloneWorkerUrl(standaloneGlobals.__QR_WORKER_CODE__, "qr"),
      { type: "module" }
    )
  }
  return new Worker(new URL("../workers/qr-decode.worker.ts", import.meta.url), {
    type: "module",
  })
}

export function ReceivePage(): React.ReactElement {
  const [stage, setStage] = useState<Stage>("camera")
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProgressInfo>(() => initialProgress())
  const [result, setResult] = useState<ResultInfo | null>(null)
  const [storedResult, setStoredResult] = useState<StoredSegmentTask | null>(null)
  const [tasks, setTasks] = useState<StoredSegmentTask[]>([])
  const [taskError, setTaskError] = useState<string | null>(null)
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
  // Whether the qr workers run the self-compiled fast backend (Y-plane decode).
  const fastBackendRef = useRef<boolean>(false)
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
  const resumeCaptureRef = useRef<() => void>(() => undefined)
  /** Root selected through history; null means accept any new transfer. */
  const targetRootRef = useRef<string | null>(null)
  /** Suppress status from a just-rejected unrelated child until reset ack. */
  const rejectingSessionRef = useRef<boolean>(false)

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await listStoredTasks())
      setTaskError(null)
    } catch (e) {
      setTaskError(`无法读取恢复历史：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  useEffect(() => {
    void refreshTasks()
    void navigator.storage?.persist?.().catch(() => false)
    const onFocus = () => void refreshTasks()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [refreshTasks])

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
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
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
        p.framesSeen = snap.framesSeen
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
        p.progressPct
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

    const recvReady = new Promise<void>((resolve) => {
      const h = (e: MessageEvent) => {
        if (e.data?.type === "ready") {
          recv.removeEventListener("message", h)
          resolve()
        }
      }
      recv.addEventListener("message", h)
    })
    // QR decode worker pool: N independent zxing workers → parallel frame decode.
    //
    // Each slot is created & wired by `spawnQrWorker(i)`. On a worker-level
    // "error" event (abnormal termination: uncaught exception, OOM in
    // zxing-wasm, module-load failure) the dead worker is **replaced** with a
    // fresh one and re-initialized — merely clearing the busy flag would let
    // captureLoop redispatch a frame to a dead worker that never replies,
    // permanently wedging that slot; repeated crashes would then shrink the
    // effective pool to 0 and capture stalls. Replacing keeps the pool at full
    // size and degrades only the few frames lost around each crash.
    const qrWorkers: Worker[] = new Array(QR_WORKER_POOL)
    const qrReadyAll: Promise<void>[] = []
    const readyResolvers: (() => void)[] = new Array(QR_WORKER_POOL)
    for (let i = 0; i < QR_WORKER_POOL; i++) {
      qrReadyAll.push(
        new Promise<void>((resolve) => {
          readyResolvers[i] = resolve
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
          // All workers share the same backend (same airferry_zxing load); use
          // the first worker's flag to decide Y-plane vs RGBA feeding.
          if (i === 0) fastBackendRef.current = d?.fast === true
          if (trackReady) readyResolvers[i]()
          dbg(`[qr#${i}] READY ✓ (fast=${d?.fast === true})`)
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
              type: "frames",
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
      // re-resolving is a harmless no-op.
      qr.addEventListener("error", (ev) => {
        dbg(`[qr#${i}] WORKER ERROR: ${ev.message || ""} @${ev.filename}:${ev.lineno}`)
        if (qrWorkersRef.current[i] !== qr) return
        qr.terminate()
        dbg(`[qr#${i}] replacing dead worker...`)
        spawnQrWorker(i, trackReady)
      })
      // A reply whose structured-clone deserialization failed never arrives:
      // leaving the slot busy wedges it forever (effective pool -1 per
      // occurrence), and the worker's state after the failed deserialization
      // is unknown — so recover exactly like the fatal "error" event:
      // terminate + replace (the replacement holds its slot busy until it
      // reports ready, so captureLoop never dispatches to it prematurely).
      qr.addEventListener("messageerror", (ev) => {
        dbg(`[qr#${i}] MESSAGE ERROR: ${String(ev.data || "")}`)
        if (qrWorkersRef.current[i] !== qr) return
        qr.terminate()
        dbg(`[qr#${i}] replacing worker after messageerror...`)
        spawnQrWorker(i, trackReady)
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

    // Preload the zstd WASM bytes on the main thread and post them to the
    // receive worker BEFORE `init`. Worker messages are FIFO, so `wasm-init`
    // is guaranteed to be processed before any frames/assemble that follow —
    // the worker installs the bytes (initZstdFromBytes) before getWasm() can
    // ever start a fallback fetch. A fire-and-forget preload would race
    // exactly this: on a slow network init/frames/assemble could arrive
    // first, and once getWasm() has started a fetch, a late wasm-init only
    // resets the NEXT call — the in-flight decompression still fails. That
    // fetch also resolved "wasm-zstd.wasm" against the worker's own assets/
    // URL (404; the file is deployed at the site root), which is how every
    // zstd-compressed transfer failed at completion. Raw transfers never
    // touch zstd, which is why small files were unaffected.
    const zstdBytes = await preloadZstdBytes()
    recv.postMessage({ type: "wasm-init", zstd: zstdBytes }, zstdBytes ? [zstdBytes] : [])

    jobIdRef.current += 1
    recv.postMessage({ type: "init", jobId: jobIdRef.current })
    // (Each qr worker's `init` was already sent by `spawnQrWorker`.)
    dbg(`[init] init sent to receive worker + ${qrWorkers.length} qr workers; waiting for ready...`)

    // 分开 await + 超时，定位是哪个 worker 卡住
    const withTimeout = (p: Promise<unknown>, label: string, ms = 8000) =>
      Promise.race([
        p.then(() => dbg(`[init] ${label} READY ✓`)),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms)
        ),
      ])
    try {
      await withTimeout(recvReady, "receive worker")
      await withTimeout(qrReady, "qr worker pool")
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
        if (rejectingSessionRef.current) return
        if (d.complete && !assemblingRef.current) {
          assemblingRef.current = true
          dbg("[recv] COMPLETE → assemble")
          stageRef.current = "recovering"
          setStage((s) => (s === "scanning" ? "recovering" : s))
          recv.postMessage({ type: "assemble", jobId: jobIdRef.current })
        }
        applyStatus(d as Record<string, unknown>)
      } else if (d.type === "meta") {
        const m = d.meta as {
          fileName?: string
          originalSize?: number
          compressedSize?: number
          compressedSizeKnown?: boolean
          segmented?: boolean
          rootId?: string
        } | null
        const targetRoot = targetRootRef.current
        if (targetRoot && (!m?.segmented || m.rootId !== targetRoot)) {
          rejectingSessionRef.current = true
          assemblingRef.current = false
          recv.postMessage({ type: "reset", jobId: jobIdRef.current })
          setProgress((p) => ({
            ...initialProgress(),
            segmentReceived: p.segmentReceived,
            segmentCount: p.segmentCount,
            statusText: "已忽略其他传输，继续等待选中任务的下一段…",
          }))
          dbg(`[recv] ignored root ${m?.rootId ?? "non-segmented"}; target=${targetRoot}`)
          return
        }
        setProgress((p) => ({
          ...p,
          fileName: m?.fileName ?? p.fileName,
          fileSize: m?.originalSize ?? p.fileSize,
          compressedSize: m?.compressedSize ?? p.compressedSize,
          compressedSizeKnown: m?.compressedSizeKnown ?? p.compressedSizeKnown,
        }))
      } else if (d.type === "reset-ack" && rejectingSessionRef.current) {
        rejectingSessionRef.current = false
        assemblingRef.current = false
        stageRef.current = "scanning"
        setStage("scanning")
      } else if (d.type === "warn") {
        dbg(`[recv] warn: ${d.message}`)
      } else if (d.type === "segment") {
        // A descriptor-v5 segment was verified and durably committed. Resume
        // capture for the next child session; the worker intentionally drops
        // the completed decoder so root-sized bytes never accumulate in RAM.
        setProgress((p) => ({
          ...p,
          complete: false,
          receivedSymbols: 0,
          totalSymbols: 0,
          decodedSymbols: 0,
          decodedBlocks: 0,
          totalBlocks: 0,
          decodedFraction: 0,
          metaConfirmed: false,
          progressPct: 0,
          statusText: `已恢复 ${d.received}/${d.count} 段，等待下一段…`,
          segmentReceived: d.received,
          segmentCount: d.count,
        }))
        assemblingRef.current = false
        stageRef.current = "scanning"
        setStage("scanning")
        resumeCaptureRef.current()
        void refreshTasks()
        dbg(`[recv] segment ${d.index + 1}/${d.count} complete; awaiting rest`)
      } else if (d.type === "segment-duplicate") {
        // Early duplicate detection: this segment was already received. Don't
        // make the user scan it again — immediately resume capture for the next
        // segment and surface a hint. The worker has already dropped the session.
        dbg(`[recv] segment ${d.index + 1} already received; skipping`)
        setProgress((p) => ({
          ...p,
          complete: false,
          receivedSymbols: 0,
          totalSymbols: 0,
          decodedSymbols: 0,
          decodedBlocks: 0,
          totalBlocks: 0,
          decodedFraction: 0,
          metaConfirmed: false,
          progressPct: 0,
          statusText: `第 ${d.index + 1} 段已接收过，请扫描下一段`,
          segmentReceived: p.segmentReceived,
          segmentCount: p.segmentCount,
        }))
        assemblingRef.current = false
        stageRef.current = "scanning"
        setStage("scanning")
        resumeCaptureRef.current()
        void refreshTasks()
      } else if (d.type === "stored-result") {
        const task = d.task as StoredSegmentTask
        targetRootRef.current = null
        dbg(`[recv] segmented task complete: ${task.rootId}`)
        setResult(null)
        setStoredResult(task)
        assemblingRef.current = false
        stageRef.current = "done"
        setStage("done")
        teardown()
        void refreshTasks()
      } else if (d.type === "segment-error") {
        // A bad/current segment is retryable. Earlier verified segments remain
        // durable, and the worker has already swapped to a fresh child session.
        assemblingRef.current = false
        setProgress((p) => ({
          ...p,
          complete: false,
          receivedSymbols: 0,
          totalSymbols: 0,
          decodedSymbols: 0,
          decodedBlocks: 0,
          totalBlocks: 0,
          decodedFraction: 0,
          metaConfirmed: false,
          progressPct: 0,
          statusText: `当前分段校验失败，可直接重新扫码：${d.message}`,
        }))
        stageRef.current = "scanning"
        setStage("scanning")
        resumeCaptureRef.current()
      } else if (d.type === "result") {
        targetRootRef.current = null
        dbg(`[recv] RESULT: ${d.recovered?.kind} crcOk=${d.crcOk}`)
        setResult({
          recovered: d.recovered,
          crcOk: d.crcOk,
          crcKnown: d.crcKnown,
        })
        setStoredResult(null)
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
  }, [teardown, dbg, applyStatus, refreshTasks])

  /** The per-frame capture + decode loop (driven by requestVideoFrameCallback). */
  const captureLoop = useCallback(() => {
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
          `(pool=${qrWorkers.length}, backend=${fastBackendRef.current ? "fast Y" : "compat RGBA"})`
      )
    }
    qrBusyRef.current[freeIdx] = true
    const fast = fastBackendRef.current
    if (fast) {
      // Fast backend: feed the Y (luminance) plane directly.
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
    } else {
      const ctx = canvas.getContext("2d", { willReadFrequently: true })
      if (!ctx) {
        qrBusyRef.current[freeIdx] = false
        rafRef.current = requestAnimationFrame(captureLoop)
        return
      }
      ctx.drawImage(video, 0, 0, w, h)
      const imageData = ctx.getImageData(0, 0, w, h)
      qrWorkers[freeIdx].postMessage(
        {
          type: "decode",
          width: w,
          height: h,
          format: "RGBA",
          rgba: imageData.data,
          jobId: jobIdRef.current,
          // NOTE: decode the WHOLE frame (no fixed 2×2 ROI). A fixed ROI assumes
          // the 4 codes land exactly at the cell centers, which real phone capture
          // (tilt/offset/crop) violates — cutting a code in half makes it
          // undecodable. zxing's maxNumberOfSymbols:4 finds codes anywhere in the
          // whole frame, which is far more tolerant (and the 4-worker pool already
          // restores the frame rate).
        },
        [imageData.data.buffer]
      )
    }
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
      rvfc.call(video, () => captureLoop())
    } else {
      rafRef.current = requestAnimationFrame(captureLoop)
    }
  }, [captureLoop])
  resumeCaptureRef.current = scheduleNextFrame

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
    rejectingSessionRef.current = false
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
    rejectingSessionRef.current = false
    targetRootRef.current = null
    jobIdRef.current += 1
    recvWorkerRef.current?.postMessage({ type: "reset", jobId: jobIdRef.current })
    rateSamplesRef.current = []
    transferStartMsRef.current = 0
    setResult(null)
    setStoredResult(null)
    setError(null)
    stageRef.current = "camera"
    setStage("camera")
  }, [teardown])

  const continueStoredTask = useCallback(async (task: StoredSegmentTask) => {
    targetRootRef.current = task.rootId
    if (await startSelectedSource()) {
      const started = await startScanning()
      if (started) {
        setProgress((p) => ({
          ...p,
          segmentReceived: task.received.length,
          segmentCount: task.segmentCount,
          statusText: `继续恢复「${task.fileName}」，已有 ${task.received.length}/${task.segmentCount} 段…`,
        }))
      }
    }
  }, [startSelectedSource, startScanning])

  const removeStoredTask = useCallback(async (task: StoredSegmentTask) => {
    if (!window.confirm(`删除「${task.fileName}」的恢复记录和已收分段？`)) return
    try {
      await deleteStoredTask(task.rootId)
      if (targetRootRef.current === task.rootId) targetRootRef.current = null
      if (storedResult?.rootId === task.rootId) {
        setStoredResult(null)
        stageRef.current = "camera"
        setStage("camera")
      }
      await refreshTasks()
    } catch (e) {
      setTaskError(`删除恢复任务失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [refreshTasks, storedResult])

  return (
    <div className="app receive-page">
      <header className="app-header receive-header">
        <div className="app-logo">
          <img src={iconUrl} alt="AirFerry" />
        </div>
        <div className="app-title">
          <h1>AirFerry 接收端</h1>
        </div>
      </header>

      <main className="app-main">
        <div className="receive-native-hint" role="note">
          <span className="hint-icon" aria-hidden="true">
            ⚠️
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
                  targetRootRef.current = null
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

          {stage === "done" && storedResult && (
            <StoredResultView task={storedResult} onReset={reset} />
          )}

          {stage === "error" && (
            <div className="error-area">
              <p className="error-msg">❌ {error}</p>
              <button onClick={reset} className="btn primary">
                重试
              </button>
            </div>
          )}
        </div>

        <TaskHistory
          tasks={tasks}
          error={taskError}
          busy={stage === "scanning" || stage === "recovering"}
          onContinue={continueStoredTask}
          onDownload={saveStoredTask}
          onDelete={removeStoredTask}
        />
      </main>

      <footer className="app-footer">
        <span className="app-footer-hint">AirFerry · 无网文件传输</span>
      </footer>
    </div>
  )
}

function StoredResultView({
  task,
  onReset,
}: {
  task: StoredSegmentTask
  onReset: () => void
}): React.ReactElement {
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await saveStoredTask(task)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="result-area">
      <h2>✅ 全部分段已安全恢复</h2>
      <p className="crc-status">✔️ 每段 CRC/SHA-256 均已校验，并已保存到本机恢复历史</p>
      <div className="file-result">
        <p>📄 {task.fileName}（{formatSize(task.rootOriginalSize)}）</p>
        <button onClick={() => void save()} disabled={saving} className="btn primary">
          {saving ? "正在写入…" : "保存文件"}
        </button>
      </div>
      {saveError && <p className="error-msg">保存失败：{saveError}</p>}
      <button onClick={onReset} className="btn primary">
        再接收一次
      </button>
    </div>
  )
}

function TaskHistory({
  tasks,
  error,
  busy,
  onContinue,
  onDownload,
  onDelete,
}: {
  tasks: StoredSegmentTask[]
  error: string | null
  busy: boolean
  onContinue: (task: StoredSegmentTask) => Promise<void>
  onDownload: (task: StoredSegmentTask) => Promise<void>
  onDelete: (task: StoredSegmentTask) => Promise<void>
}): React.ReactElement | null {
  const [actionError, setActionError] = useState<string | null>(null)
  const [workingRoot, setWorkingRoot] = useState<string | null>(null)
  if (tasks.length === 0 && !error) return null

  const run = async (task: StoredSegmentTask, action: () => Promise<void>) => {
    setWorkingRoot(task.rootId)
    setActionError(null)
    try {
      await action()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorkingRoot(null)
    }
  }

  return (
    <section className="task-history" aria-label="恢复历史">
      <div className="task-history-title">
        <h2>恢复历史</h2>
        <span>{tasks.length} 个任务</span>
      </div>
      {(error || actionError) && <p className="error-msg">{error || actionError}</p>}
      <div className="task-list">
        {tasks.map((task) => {
          const received = task.received.length
          const pct = task.segmentCount > 0 ? (received / task.segmentCount) * 100 : 0
          const complete = task.state === "complete"
          const working = workingRoot === task.rootId
          return (
            <article className="task-card" key={task.rootId}>
              <div className="task-card-head">
                <div>
                  <div className="task-name">{task.fileName}</div>
                  <div className="task-meta">
                    {complete ? "已完成" : "待恢复"} · {received}/{task.segmentCount} 段 · {formatSize(task.rootOriginalSize)}
                  </div>
                  {!complete && (
                    <div className="task-missing">缺少第 {missingSegmentSummary(task)} 段</div>
                  )}
                </div>
                <time>{new Date(task.updatedAt).toLocaleString()}</time>
              </div>
              <div className="task-progress" aria-label={`已恢复 ${received}/${task.segmentCount} 段`}>
                <span style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <div className="task-actions">
                {complete ? (
                  <button
                    className="btn primary"
                    disabled={working}
                    onClick={() => void run(task, () => onDownload(task))}
                  >
                    {working ? "处理中…" : "保存文件"}
                  </button>
                ) : (
                  <button
                    className="btn primary"
                    disabled={busy || working}
                    onClick={() => void run(task, () => onContinue(task))}
                  >
                    继续恢复
                  </button>
                )}
                <button
                  className="btn"
                  disabled={working}
                  onClick={() => void run(task, () => onDelete(task))}
                >
                  删除记录
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
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
        {progress.segmentCount > 1 && (
          <div className="progress-row progress-row-segment">
            <span className="progress-label">分段</span>
            <span className="progress-value">
              {progress.segmentReceived} / {progress.segmentCount} 段
              {progress.segmentReceived < progress.segmentCount
                ? "（已收，继续扫描下一段）"
                : "（全部已收，合并中…）"}
            </span>
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
  const { recovered, crcOk, crcKnown } = result
  return (
    <div className="result-area">
      <h2>✅ 接收完成</h2>
      <p className="crc-status">
        {crcKnown ? (crcOk ? "✔️ CRC 校验通过" : "⚠️ CRC 校验失败（数据可能损坏）") : "ℹ️ 未提供 CRC，未校验"}
      </p>
      {recovered.kind === "text" && (
        <TextView
          text={recovered.text}
          valid={recovered.validUtf8}
        />
      )}
      {recovered.kind === "file" && (
        <FileView name={recovered.name} data={recovered.data} />
      )}
      {recovered.kind === "bundle" && (
        <BundleView entries={recovered.entries} />
      )}
      <button onClick={onReset} className="btn primary">
        再接收一次
      </button>
    </div>
  )
}

function TextView({
  text,
  valid,
}: {
  text: string
  valid: boolean
}): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  const onSave = () => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "文字消息.txt"
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="text-result">
      {!valid && <p className="warn">⚠️ 文本包含无效 UTF-8，已尽力解码</p>}
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
  data: Uint8Array
}): React.ReactElement {
  const onDownload = () => {
    const blob = new Blob([data.slice().buffer as ArrayBuffer], {
      type: "application/octet-stream",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }
  const sizeKiB = (data.length / 1024).toFixed(1)
  return (
    <div className="file-result">
      <p>
        📄 {name}（{sizeKiB} KiB）
      </p>
      <button onClick={onDownload} className="btn primary">
        下载
      </button>
    </div>
  )
}

function BundleView({
  entries,
}: {
  entries: { name: string; data: Uint8Array }[]
}): React.ReactElement {
  const onDownloadAll = () => {
    // Download each sequentially (no zip dependency in M2).
    for (const e of entries) {
      const blob = new Blob([e.data.slice().buffer as ArrayBuffer], {
        type: "application/octet-stream",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = e.name
      a.click()
      URL.revokeObjectURL(url)
    }
  }
  return (
    <div className="bundle-result">
      <p>📦 {entries.length} 个文件</p>
      <ul className="bundle-list">
        {entries.map((e, i) => {
          const onDownload = () => {
            const blob = new Blob([e.data.slice().buffer as ArrayBuffer], {
              type: "application/octet-stream",
            })
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = e.name
            a.click()
            URL.revokeObjectURL(url)
          }
          return (
            <li key={i}>
              <span>
                {e.name}（{(e.data.length / 1024).toFixed(1)} KiB）
              </span>
              <button onClick={onDownload} className="btn btn-sm">
                下载
              </button>
            </li>
          )
        })}
      </ul>
      <button onClick={onDownloadAll} className="btn primary">
        全部下载
      </button>
    </div>
  )
}

export default ReceivePage
