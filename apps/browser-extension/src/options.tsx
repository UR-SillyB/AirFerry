/**
 * EasyTransfer sender app — single full-tab page with internal routing across
 * the four required screens: file select → params → play → stats.
 */
import { useState, useCallback } from "react"
import "@/assets/app.css"
import { ensureWasm, SenderSessionWasm } from "@/wasm/loader"
import { deriveSessionId, contentFingerprint } from "@/wasm/session"
import { preparePayload, CompressionAlgorithm } from "@/wasm/compress"
import { crc32 } from "@/wasm/crc32"
import { FileSelectPage } from "@/pages/FileSelectPage"
import { ParamsPage } from "@/pages/ParamsPage"
import { PlayPage } from "@/pages/PlayPage"
import { StatsPage } from "@/pages/StatsPage"
import { DEFAULT_CONFIG, type Page, type TransferConfig } from "@/types"

export type { Page, TransferConfig }

export interface AppState {
  page: Page
  file: File | null
  compressed: Uint8Array | null
  /** Compression algorithm applied to `compressed` (None = raw bytes). */
  compressionAlgorithm: CompressionAlgorithm
  /** CRC32 of the original (uncompressed) file bytes. */
  fileCrc32: number
  sessionId: { lo: bigint; hi: bigint } | null
  session: SenderSessionWasm | null
  config: TransferConfig
  /** Loading state while WASM encoder is being initialized (can be slow for large files). */
  initializing: boolean
  /** Error message if WASM session creation fails. */
  error: string | null
}

export default function App() {
  const [state, setState] = useState<AppState>({
    page: "select",
    file: null,
    compressed: null,
    compressionAlgorithm: CompressionAlgorithm.None,
    fileCrc32: 0,
    sessionId: null,
    session: null,
    config: DEFAULT_CONFIG,
    initializing: false,
    error: null
  })

  const go = useCallback((page: Page) => setState((s) => ({ ...s, page })), [])

  /** Stage 1: file chosen → compress + derive session id, then go to params. */
  const onFileSelected = useCallback(async (file: File) => {
    await ensureWasm()
    const buf = new Uint8Array(await file.arrayBuffer())
    const { payload: compressed, algorithm, compressedSize } = await preparePayload(buf)
    console.log(
      `Compression: ${file.size} → ${compressedSize} bytes ` +
        `(${file.size > 0 ? ((compressedSize / file.size) * 100).toFixed(1) : "0"}%)`
    )
    const crc = crc32(buf)
    // Content fingerprint: first 1KB + last 1KB.
    const head = buf.slice(0, 1024)
    const tail = buf.slice(Math.max(0, buf.length - 1024))
    const fp = contentFingerprint(head, tail)
    const mtimeMs = BigInt(file.lastModified)
    const sessionId = deriveSessionId(
      file.name,
      BigInt(file.size),
      mtimeMs,
      fp
    )
    setState((s) => ({
      ...s,
      file,
      compressed,
      compressionAlgorithm: algorithm,
      fileCrc32: crc,
      sessionId,
      page: "params",
      error: null
    }))
  }, [])

  /** Stage 2: params confirmed → build the WASM sender session, go to play. */
  const onStart = useCallback(async () => {
    await ensureWasm()
    if (!state.compressed || !state.sessionId || !state.file) return
    const cfg = state.config
    setState((s) => ({ ...s, initializing: true, error: null }))
    try {
      const session = new SenderSessionWasm(
        state.compressed,
        state.sessionId.lo,
        state.sessionId.hi,
        cfg.redundancyPct,
        cfg.symbolSize,
        state.file.name,
        BigInt(state.file.size),
        state.fileCrc32,
        state.compressionAlgorithm
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
  }, [state.compressed, state.sessionId, state.file, state.fileCrc32, state.compressionAlgorithm, state.config])

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
        <div className={`step ${state.page === "select" ? "active" : state.compressed ? "done" : ""}`} onClick={() => go("select")}>
          <span className="step-dot">1</span> 选择文件
        </div>
        <div className="step-line" />
        <div className={`step ${state.page === "params" ? "active" : state.session ? "done" : ""}`} onClick={() => state.compressed && go("params")}>
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
          <FileSelectPage onSelected={onFileSelected} file={state.file} />
        )}
        {state.page === "params" && (
          <ParamsPage
            file={state.file}
            compressedSize={state.compressed?.length ?? 0}
            config={state.config}
            onChange={updateConfig}
            onStart={onStart}
            initializing={state.initializing}
          />
        )}
        {state.page === "play" && state.session && (
          <PlayPage
            session={state.session}
            config={state.config}
            sessionId={state.sessionId!}
            totalBytes={state.compressed?.length ?? 0}
          />
        )}
        {state.page === "stats" && state.session && (
          <StatsPage
            session={state.session}
            fileSize={state.file?.size ?? 0}
          />
        )}
      </main>
    </div>
  )
}
