/**
 * EasyTransfer sender app — single full-tab page with internal routing across
 * the four required screens: file select → params → play → stats.
 *
 * Supports multiple files: when ≥2 files are selected they are packed into a
 * single bundle container (`bundle.ts`) before compression, so the whole batch
 * travels as one RaptorQ object / one QR video stream. The receiver detects the
 * bundle magic after recovery and unpacks every file. A single-file selection
 * keeps the original (non-bundled) path for full backward compatibility.
 */
import { useState, useCallback, useEffect } from "react"
import "@/assets/app.css"
import { ensureWasm, SenderSessionWasm } from "@/wasm/loader"
import { deriveSessionId, contentFingerprint } from "@/wasm/session"
import { preparePayload, CompressionAlgorithm } from "@/wasm/compress"
import { crc32 } from "@/wasm/crc32"
import { buildBundle } from "@/wasm/bundle"
import { FileSelectPage } from "@/pages/FileSelectPage"
import { ParamsPage } from "@/pages/ParamsPage"
import { PlayPage } from "@/pages/PlayPage"
import { StatsPage } from "@/pages/StatsPage"
import { DEFAULT_CONFIG, type Page, type TransferConfig } from "@/types"

export type { Page, TransferConfig }

/** A "send unit": either one real file or a bundle of several. */
interface PreparedPayload {
  /** Final bytes fed to the RaptorQ encoder (already compressed). */
  compressed: Uint8Array
  /** Compression algorithm applied to `compressed`. */
  compressionAlgorithm: CompressionAlgorithm
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
  /** Files chosen by the user (1 or more). */
  files: File[]
  /** The prepared transfer unit (once files are staged). Null until ready. */
  prepared: PreparedPayload | null
  session: SenderSessionWasm | null
  config: TransferConfig
  /** Loading state while WASM encoder is being initialized (can be slow for large files). */
  initializing: boolean
  /** Error message if WASM session creation fails. */
  error: string | null
}

export default function App() {
  useEffect(() => {
    document.title = "易传 · 文件传输"
  }, [])

  const [state, setState] = useState<AppState>({
    page: "select",
    files: [],
    prepared: null,
    session: null,
    config: DEFAULT_CONFIG,
    initializing: false,
    error: null
  })

  const go = useCallback((page: Page) => setState((s) => ({ ...s, page })), [])

  /**
   * Stage 1: files chosen → pack (if >1), compress, derive session id, go to
   * params. A single file skips bundling so the old single-file flow is
   * byte-identical for old receivers.
   */
  const onFilesSelected = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      // User removed the last file → reset back to the select screen.
      setState((s) => ({ ...s, files: [], prepared: null, page: "select" }))
      return
    }
    await ensureWasm()

    const isBundle = files.length > 1
    let raw: Uint8Array
    let displayName: string
    if (isBundle) {
      const built = await buildBundle(files)
      raw = built.bytes
      displayName = `${files.length}个文件打包`
      console.log(`Bundle: ${files.length} files, ${raw.length} bytes pre-compress`)
    } else {
      raw = new Uint8Array(await files[0].arrayBuffer())
      displayName = files[0].name
    }

    const { payload: compressed, algorithm, compressedSize } = await preparePayload(raw)
    console.log(
      `Compression: ${raw.length} → ${compressedSize} bytes ` +
        `(${raw.length > 0 ? ((compressedSize / raw.length) * 100).toFixed(1) : "0"}%)`
    )
    const crc = crc32(raw)
    // Content fingerprint: first 1KB + last 1KB (of the pre-compress bytes).
    const head = raw.slice(0, 1024)
    const tail = raw.slice(Math.max(0, raw.length - 1024))
    const fp = contentFingerprint(head, tail)
    // Session id derived from transfer identity. For a bundle we fold in the
    // count + names so different file sets never collide. For a single file we
    // pass its name/size/mtime exactly as before.
    let sessionId: { lo: bigint; hi: bigint }
    if (isBundle) {
      const mtimeMax = files.reduce(
        (m, f) => (f.lastModified > m ? f.lastModified : m),
        0
      )
      const namesJoined = files.map((f) => f.name).join("\u0001")
      sessionId = deriveSessionId(
        namesJoined,
        BigInt(raw.length),
        BigInt(mtimeMax),
        fp
      )
    } else {
      const f = files[0]
      sessionId = deriveSessionId(
        f.name,
        BigInt(f.size),
        BigInt(f.lastModified),
        fp
      )
    }

    setState((s) => ({
      ...s,
      files,
      prepared: {
        compressed,
        compressionAlgorithm: algorithm,
        preCrc32: crc,
        displayName,
        originalSize: raw.length,
        sessionId
      },
      page: "params",
      error: null
    }))
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
      setState((s) => ({ ...s, config: { ...s.config, ...patch } })),
    []
  )

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">易</div>
        <h1>易传 · 文件传输</h1>
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
          <FileSelectPage files={state.files} onSelected={onFilesSelected} />
        )}
        {state.page === "params" && state.prepared && (
          <ParamsPage
            files={state.files}
            displayName={state.prepared.displayName}
            originalSize={state.prepared.originalSize}
            compressedSize={state.prepared.compressed.length}
            isBundle={state.files.length > 1}
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
    </div>
  )
}
