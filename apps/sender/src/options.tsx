/**
 * AirFerry sender app — single full-tab page with internal routing across
 * the four required screens: file select → params → play → stats.
 *
 * Supports multiple files: when ≥2 files are selected they are packed into a
 * single bundle container (`bundle.ts`) before compression, so the whole batch
 * travels as one RaptorQ object / one QR video stream. The receiver detects the
 * bundle magic after recovery and unpacks every file. A single-file selection
 * keeps the original (non-bundled) path for full backward compatibility.
 */
import { useState, useCallback, useEffect, useRef } from "react"
import "@/assets/app.css"
import iconUrl from "../assets/icon128.png"
import { ensureWasm, SenderSessionWasm } from "@/wasm/loader"
import { FileSelectPage } from "@/pages/FileSelectPage"
import { ParamsPage } from "@/pages/ParamsPage"
import { PlayPage } from "@/pages/PlayPage"
import { StatsPage } from "@/pages/StatsPage"
import { CompressProgress, type CompressPhase } from "@/components/CompressProgress"
import { loadConfig, saveConfig, type Page, type TransferConfig, type TransferKind } from "@/types"

/**
 * The compress worker. Built by Parcel 2 into a separate bundle per target
 * (chrome-mv2/mv3, firefox-mv2/mv3). It runs the heavy, synchronous-WASM file
 * prep (bundle → compress → crc → fingerprint → session id) off the main thread
 * so the UI stays responsive — without this the compressors freeze the page.
 */
const compressWorker = new Worker(
  new URL("./workers/compress.worker.ts", import.meta.url),
  { type: "module" }
)

/**
 * Pre-load zstd WASM bytes on the main thread and transfer them to the worker.
 * Inside a Web Worker, chrome.runtime.getURL() + fetch() may fail silently,
 * causing compression to always fall back to raw (100% ratio). By loading the
 * bytes here and passing them as a transferable, we guarantee the worker always
 * has the WASM binary available regardless of its execution context.
 */
;(async () => {
  try {
    const wasmUrl = chrome.runtime.getURL("wasm-zstd.wasm")
    const resp = await fetch(wasmUrl, { credentials: "same-origin" })
    if (resp.ok) {
      const bytes = await resp.arrayBuffer()
      compressWorker.postMessage({ type: "wasm-init", zstd: bytes }, [bytes])
    } else {
      console.warn("Failed to pre-load wasm-zstd.wasm:", resp.status)
    }
  } catch (e) {
    console.warn("Failed to pre-load wasm-zstd.wasm:", e)
  }
})()

export type { Page, TransferConfig, TransferKind }

/** A "send unit": either one real file or a bundle of several. */
interface PreparedPayload {
  /** Final bytes fed to the RaptorQ encoder (already compressed). */
  compressed: Uint8Array
  /** Compression algorithm applied to `compressed` (mirrors compress.rs tags). */
  compressionAlgorithm: number
  /** CRC32 of the *pre-compression* bytes (single file, or whole bundle). */
  preCrc32: number
  /** Display name for the descriptor. Single file → its name; bundle → "N files". */
  displayName: string
  /** Total original (uncompressed) byte count for the transfer. */
  originalSize: number
  /** Session id derived from the transfer identity. */
  sessionId: { lo: bigint; hi: bigint }
}

export interface AppState {
  page: Page
  /** Transfer kind: "file" (default) or "text". Picks the select-page Tab. */
  kind: TransferKind
  /** Files chosen by the user (1 or more), in the file Tab. */
  files: File[]
  /** Text typed in the text Tab. */
  text: string
  /** The prepared transfer unit (once files/text are staged). Null until ready. */
  prepared: PreparedPayload | null
  session: SenderSessionWasm | null
  config: TransferConfig
  /** Loading state while WASM encoder is being initialized (can be slow for large files). */
  initializing: boolean
  /**
   * Compress-worker phase. While set (not null/done), a full-screen progress
   * overlay is shown — the prep runs in the worker so this spinner keeps
   * animating even during the slow synchronous-WASM compress.
   */
  compressPhase: CompressPhase | null
  /** Error message if WASM session creation or compression fails. */
  error: string | null
}

export default function App() {
  useEffect(() => {
    document.title = "AirFerry · 无网文件传输"
  }, [])

  // Initialize config from localStorage (so the user's last-used transfer
  // params — redundancy, fps, symbol size, brightness, multi-QR — carry over to
  // every subsequent transfer instead of resetting to defaults each time).
  const [state, setState] = useState<AppState>({
    page: "select",
    kind: "file",
    files: [],
    text: "",
    prepared: null,
    session: null,
    config: loadConfig(),
    initializing: false,
    compressPhase: null,
    error: null
  })

  const go = useCallback((page: Page) => setState((s) => ({ ...s, page })), [])

  /**
   * Handle the compress worker's messages: stage progress updates and the final
   * prepared payload. Registered once (the worker is a module singleton); a ref
   * tracks whether we're actively awaiting a result so stale messages from a
   * superseded selection don't clobber state.
   */
  const awaitingResult = useRef(false)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data
      if (!msg || typeof msg.phase !== "string") return

      if (msg.phase === "done") {
        if (!awaitingResult.current) return
        awaitingResult.current = false
        // Convert the transferable ArrayBuffer back into a Uint8Array view and
        // the decimal-string session-id halves back into bigint.
        const compressed = new Uint8Array(msg.compressed as ArrayBuffer)
        setState((s) => ({
          ...s,
          prepared: {
            compressed,
            compressionAlgorithm: msg.algorithm,
            preCrc32: msg.preCrc32,
            displayName: msg.displayName,
            originalSize: msg.originalSize,
            sessionId: {
              lo: BigInt(msg.sessionId.lo),
              hi: BigInt(msg.sessionId.hi),
            },
          },
          compressPhase: null,
          page: "params",
          error: null,
        }))
      } else if (msg.phase === "error") {
        awaitingResult.current = false
        setState((s) => ({
          ...s,
          compressPhase: null,
          error: `文件处理失败: ${msg.message}`,
        }))
      } else {
        // stage progress: reading / bundling / zstd / xz
        if (awaitingResult.current) {
          setState((s) => ({ ...s, compressPhase: msg.phase as CompressPhase }))
        }
      }
    }
    compressWorker.addEventListener("message", handler)
    return () => compressWorker.removeEventListener("message", handler)
  }, [])

  /**
   * Stage 1 (file): files chosen → hand them to the compress worker, which
   * packs (if >1), compresses, and derives the session id OFF the main thread
   * while the UI shows a progress overlay. A single file skips bundling so the
   * old single-file flow is byte-identical for old receivers.
   */
  const onFilesSelected = useCallback((files: File[]) => {
    if (files.length === 0) {
      // User removed the last file → reset back to the select screen.
      setState((s) => ({ ...s, files: [], prepared: null, page: "select" }))
      return
    }
    awaitingResult.current = true
    setState((s) => ({
      ...s,
      kind: "file",
      files,
      compressPhase: "reading",
      error: null,
    }))
    compressWorker.postMessage({ files })
  }, [])

  /**
   * Stage 1 (text): submitted text → hand it to the compress worker, which
   * wraps it in the ETTEXTv1 magic, compresses, and derives the session id.
   * Same worker pipeline as files; the result is a normal PreparedPayload.
   */
  const onTextEntered = useCallback((text: string) => {
    if (text.trim().length === 0) return
    awaitingResult.current = true
    setState((s) => ({
      ...s,
      kind: "text",
      text,
      compressPhase: "reading",
      error: null,
    }))
    compressWorker.postMessage({ text })
  }, [])

  /**
   * Switch the select-page Tab. Clears the OTHER kind's staged selection so a
   * half-prepared file transfer doesn't leak into a text flow and vice versa.
   * Stays on the select page (no prepared payload → can't advance yet).
   */
  const onKindChange = useCallback((kind: TransferKind) => {
    setState((s) => {
      if (s.kind === kind) return s
      return kind === "file"
        ? { ...s, kind, text: "", prepared: null, page: "select" }
        : { ...s, kind, files: [], prepared: null, page: "select" }
    })
  }, [])

  /** Stage 2: params confirmed → build the WASM sender session, go to play. */
  const onStart = useCallback(async () => {
    await ensureWasm()
    if (!state.prepared) return
    const cfg = state.config
    const p = state.prepared
    setState((s) => ({ ...s, initializing: true, error: null }))
    try {
      const session = new SenderSessionWasm(
        p.compressed,
        p.sessionId.lo,
        p.sessionId.hi,
        cfg.redundancyPct,
        cfg.symbolSize,
        p.displayName,
        BigInt(p.originalSize),
        p.preCrc32,
        p.compressionAlgorithm
      )
      setState((s) => ({ ...s, session, page: "play", initializing: false }))
    } catch (e: any) {
      console.error("WASM session creation failed:", e)
      setState((s) => ({
        ...s,
        initializing: false,
        error: `编码器初始化失败: ${e?.message || e}`
      }))
    }
  }, [state.prepared, state.config])

  const updateConfig = useCallback(
    (patch: Partial<TransferConfig>) =>
      setState((s) => {
        const next = { ...s.config, ...patch }
        // Persist every change so the chosen params survive a page reload / next
        // transfer. saveConfig swallows storage errors, so this never throws.
        saveConfig(next)
        return { ...s, config: next }
      }),
    []
  )

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo"><img src={iconUrl} alt="AirFerry" /></div>
        <h1>AirFerry · 无网文件传输</h1>
      </header>
      <div className="steps">
        <div className={`step ${state.page === "select" ? "active" : state.prepared ? "done" : ""}`} onClick={() => go("select")}>
          <span className="step-dot">1</span> 选择文件
        </div>
        <div className="step-line" />
        <div className={`step ${state.page === "params" ? "active" : state.session ? "done" : ""}`} onClick={() => state.prepared && go("params")}>
          <span className="step-dot">2</span> 传输参数
        </div>
        <div className="step-line" />
        <div className={`step ${state.page === "play" ? "active" : ""}`} onClick={() => state.session && go("play")}>
          <span className="step-dot">3</span> 播放传输
        </div>
        <div className="step-line" />
        <div className={`step ${state.page === "stats" ? "active" : ""}`} onClick={() => state.session && go("stats")}>
          <span className="step-dot">4</span> 统计
        </div>
      </div>
      <main className="app-main">
        {state.error && (
          <div className="error-banner" style={{ padding: "12px 16px", marginBottom: 16, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 14 }}>
            {state.error}
          </div>
        )}
        {state.page === "select" && (
          <FileSelectPage
            kind={state.kind}
            files={state.files}
            text={state.text}
            onKindChange={onKindChange}
            onSelected={onFilesSelected}
            onTextEntered={onTextEntered}
          />
        )}
        {state.page === "params" && state.prepared && (
          <ParamsPage
            kind={state.kind}
            files={state.files}
            displayName={state.prepared.displayName}
            originalSize={state.prepared.originalSize}
            compressedSize={state.prepared.compressed.length}
            isBundle={state.kind === "file" && state.files.length > 1}
            config={state.config}
            onChange={updateConfig}
            onStart={onStart}
            initializing={state.initializing}
          />
        )}
        {state.page === "play" && state.session && state.prepared && (
          <PlayPage
            session={state.session}
            config={state.config}
            sessionId={state.prepared.sessionId}
            totalBytes={state.prepared.compressed.length}
          />
        )}
        {state.page === "stats" && state.session && state.prepared && (
          <StatsPage
            session={state.session}
            fileSize={state.prepared.originalSize}
          />
        )}
      </main>
      {/* Compress progress overlay — shown while the worker prepares the file.
          The worker keeps the main thread free, so this spinner animates even
          during the slow xz pass. */}
      <CompressProgress
        phase={state.compressPhase}
        isBundle={state.kind === "file" && state.files.length > 1}
        displayName={
          state.kind === "text"
            ? "文字消息"
            : state.files.length > 0
              ? (state.files.length > 1 ? `${state.files.length}个文件` : state.files[0].name)
              : undefined
        }
        originalSize={
          state.kind === "text"
            ? (state.text.length > 0 ? new TextEncoder().encode(state.text).length + 8 : undefined)
            : (state.files.reduce((sum, f) => sum + f.size, 0) || undefined)
        }
      />
    </div>
  )
}
