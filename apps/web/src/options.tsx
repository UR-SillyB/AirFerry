/**
 * AirFerry options / sender page (AF2 protocol).
 *
 * Route: select (with settings modal/page) → play → stats.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import {
  type CompressPhase,
  type Page,
  type PendingItem,
  type TransferConfig,
  loadConfig,
  saveConfig,
} from "@/types"
import { FileSelectPage } from "@/pages/FileSelectPage"
import { SettingsPage } from "@/pages/SettingsPage"
import { PlayPage } from "@/pages/PlayPage"
import { StatsPage } from "@/pages/StatsPage"
import {
  ensureWasm,
  SenderBuilderWasm,
  type SenderSessionWasm,
} from "@/wasm/loader"
import { getCachedManifest, putCachedManifest } from "@/lib/sender-cache"
import {
  type ChunkEncoding,
  prepareChunkEncodings,
} from "@/lib/chunk-encode"
import { SettingsIcon } from "@/components/icons"
import type { PreparedItem } from "@/workers/compress.worker"
import { senderPathForFile, type SenderFileItem } from "@/lib/sender-path"
import "@/assets/app.css"

const iconUrl = new URL("../assets/icon.png", import.meta.url).href

function createCompressWorker(): Worker {
  if (typeof globalThis !== "undefined" && (globalThis as any).__WORKER_CODE__) {
    const blob = new Blob([(globalThis as any).__WORKER_CODE__], { type: "application/javascript" })
    const url = URL.createObjectURL(blob)
    return new Worker(url)
  }
  return new Worker(new URL("./workers/compress.worker.ts", import.meta.url), {
    type: "module",
  })
}

async function initializeCompressWorker(worker: Worker): Promise<void> {
  worker.postMessage({ type: "wasm-init" })
}

function itemsToFiles(items: PendingItem[]): SenderFileItem[] {
  return items.map((it): SenderFileItem => {
    if (it.kind === "file") {
      return { file: it.file, path: it.path ?? senderPathForFile(it.file) }
    }
    const name = it.name?.trim() ? it.name.trim() : "文字消息.txt"
    const finalName = name.toLowerCase().endsWith(".txt") ? name : `${name}.txt`
    return {
      file: new File([it.content], finalName, {
        type: "text/plain;charset=utf-8",
        lastModified: Date.now(),
      }),
      path: finalName,
    }
  })
}

interface PreparedPayload {
  items: PreparedItem[]
  totalBytes: number
  displayName: string
}

export interface AppState {
  page: Page
  /** Page the settings screen was opened from; closing settings returns here. */
  settingsFrom: Page | null
  items: PendingItem[]
  prepared: PreparedPayload | null
  session: SenderSessionWasm | null
  config: TransferConfig
  initializing: boolean
  compressPhase: CompressPhase | null
  error: string | null
}

const freedSessions = new WeakSet<SenderSessionWasm>()
function freeSenderSession(session: SenderSessionWasm | null | undefined): void {
  if (!session || freedSessions.has(session)) return
  freedSessions.add(session)
  try {
    session.free()
  } catch (_) {
    // Ignore double-free errors
  }
}

export default function App() {
  useEffect(() => {
    document.title = "AirFerry · 无网文件传输"
  }, [])

  const [state, setState] = useState<AppState>({
    page: "select",
    settingsFrom: null,
    items: [],
    prepared: null,
    session: null,
    config: loadConfig(),
    initializing: false,
    compressPhase: null,
    error: null,
  })

  const epoch = useRef(0)
  const issuedEpoch = useRef(-1)
  const workerRef = useRef<Worker | null>(null)
  const restartWorkerRef = useRef<() => void>(() => undefined)
  const mountedRef = useRef(true)
  const ownedSessionRef = useRef<SenderSessionWasm | null>(null)
  // Latest session builder. The worker "done" handler lives in a mount-time
  // effect closure, so it must call through this ref to see fresh config.
  const startPlaybackRef = useRef<(p: PreparedPayload, startEpoch: number) => Promise<void>>(
    async () => undefined
  )

  const releaseOwnedSession = useCallback(() => {
    const s = ownedSessionRef.current
    if (s) {
      ownedSessionRef.current = null
      freeSenderSession(s)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      releaseOwnedSession()
    }
  }, [releaseOwnedSession])

  useEffect(() => {
    if (typeof window === "undefined") return
    let worker: Worker | null = null
    let disposed = false
    const handler = (e: MessageEvent) => {
      const msg = e.data
      if (!msg || typeof msg.phase !== "string") return
      if (typeof msg.jobId === "number") {
        if (msg.jobId !== epoch.current || issuedEpoch.current !== epoch.current) return
      } else if (issuedEpoch.current !== epoch.current) {
        return
      }

      if (msg.phase === "error") {
        issuedEpoch.current = -1
        setState((s) => ({
          ...s,
          compressPhase: null,
          error: msg.message || "文件准备失败",
        }))
        return
      }

      if (msg.phase === "reading") {
        setState((s) => ({
          ...s,
          compressPhase: "reading",
          error: null,
        }))
        return
      }

      if (msg.phase === "done") {
        issuedEpoch.current = -1
        const payload: PreparedPayload = {
          items: msg.items as PreparedItem[],
          totalBytes: msg.totalBytes as number,
          displayName: msg.displayName as string,
        }
        setState((s) => ({
          ...s,
          prepared: payload,
          compressPhase: null,
          error: null,
        }))
        // Files are ready — build the encoder session and jump straight to the
        // QR play page (no intermediate params step in the main flow).
        void startPlaybackRef.current(payload, epoch.current)
      }
    }

    const failWorker = (message: string) => {
      if (disposed) return
      setState((s) => ({
        ...s,
        compressPhase: null,
        error: `文件处理线程错误: ${message}，正在重启…`,
      }))
      startWorker()
    }

    const errorHandler = (e: ErrorEvent) => {
      e.preventDefault()
      failWorker(e.message || "worker crashed")
    }
    const messageErrorHandler = () => failWorker("无法解析 worker 消息")
    const startWorker = () => {
      worker?.removeEventListener("message", handler)
      worker?.removeEventListener("error", errorHandler)
      worker?.removeEventListener("messageerror", messageErrorHandler)
      worker?.terminate()
      try {
        worker = createCompressWorker()
        workerRef.current = worker
        worker.addEventListener("message", handler)
        worker.addEventListener("error", errorHandler)
        worker.addEventListener("messageerror", messageErrorHandler)
        void initializeCompressWorker(worker).catch((e) =>
          failWorker(e instanceof Error ? e.message : String(e))
        )
      } catch (e) {
        worker = null
        workerRef.current = null
        setState((s) => ({
          ...s,
          compressPhase: null,
          error: `无法启动文件处理线程: ${e instanceof Error ? e.message : String(e)}`,
        }))
      }
    }
    restartWorkerRef.current = startWorker
    startWorker()
    return () => {
      disposed = true
      restartWorkerRef.current = () => undefined
      worker?.terminate()
      workerRef.current = null
    }
  }, [])

  const onItemsChange = useCallback((items: PendingItem[]) => {
    releaseOwnedSession()
    epoch.current += 1
    if (issuedEpoch.current >= 0) restartWorkerRef.current()
    issuedEpoch.current = -1
    setState((s) => ({
      ...s,
      items,
      prepared: null,
      session: null,
      compressPhase: null,
      error: null,
    }))
  }, [releaseOwnedSession])

  const startPlaybackWithPayload = useCallback(async (p: PreparedPayload, startEpoch: number) => {
    const cfg = state.config
    setState((s) => ({ ...s, initializing: true, error: null }))
    try {
      await ensureWasm()
      if (!mountedRef.current || epoch.current !== startEpoch) {
        if (mountedRef.current) {
          setState((s) => ({ ...s, initializing: false }))
        }
        return
      }
      const chunkRawSize = 8 * 1024 * 1024
      const channelBps = Math.round(
        cfg.symbolSize * (cfg.fps || 60) * Math.max(1, cfg.multiQr || 1)
      )
      const forceFull = p.totalBytes <= chunkRawSize
      let encodings: ChunkEncoding[] = []
      try {
        encodings = await prepareChunkEncodings(p.items, {
          chunkRawSize,
          channelBps,
          forceFull,
        })
      } catch (e) {
        console.warn("chunk pre-encode failed, falling back to lazy encoding:", e)
        encodings = []
      }
      if (!mountedRef.current || epoch.current !== startEpoch) {
        if (mountedRef.current) {
          setState((s) => ({ ...s, initializing: false }))
        }
        return
      }
      const fillBuilder = (): SenderBuilderWasm => {
        const builder = new SenderBuilderWasm()
        for (const it of p.items) {
          builder.add_entry(it.kind, it.path, new Uint8Array(it.content))
        }
        for (const c of encodings) {
          builder.add_preencoded_chunk(c.index, c.codec, c.data)
        }
        return builder
      }
      let session: SenderSessionWasm | null = null
      try {
        const cached = await getCachedManifest(p.items, chunkRawSize)
        if (!mountedRef.current || epoch.current !== startEpoch) {
          if (mountedRef.current) {
            setState((s) => ({ ...s, initializing: false }))
          }
          return
        }
        if (cached && cached.chunkRawSize === chunkRawSize) {
          try {
            session = fillBuilder().build_cached(
              cached.manifestHex,
              cfg.symbolSize,
              chunkRawSize,
              cfg.redundancyPct
            )
          } catch (e) {
            console.warn("cached manifest unusable, rebuilding:", e)
            session = null
          }
        }
      } catch {
        session = null
      }
      if (!session) {
        session = fillBuilder().build(cfg.symbolSize, chunkRawSize, cfg.redundancyPct)
        try {
          await putCachedManifest(p.items, session.manifest_json(), chunkRawSize)
        } catch {
          // advisory
        }
      }
      if (!mountedRef.current || epoch.current !== startEpoch) {
        freeSenderSession(session)
        releaseOwnedSession()
        if (mountedRef.current) {
          setState((s) => ({ ...s, session: null, initializing: false }))
        }
        return
      }
      releaseOwnedSession()
      ownedSessionRef.current = session
      setState((s) => ({ ...s, session, page: "play", initializing: false }))
    } catch (e: any) {
      console.error("WASM session creation failed:", e)
      setState((s) => ({
        ...s,
        initializing: false,
        error: `编码器初始化失败: ${e?.message || e}`,
      }))
    }
  }, [state.config, releaseOwnedSession])

  startPlaybackRef.current = startPlaybackWithPayload

  const onPlay = useCallback(() => {
    const items = state.items
    if (items.length === 0) return
    if (state.compressPhase != null || state.initializing) return
    const worker = workerRef.current
    if (!worker) {
      setState((s) => ({ ...s, error: "文件处理线程尚未就绪，请重试" }))
      return
    }
    epoch.current += 1
    const e = epoch.current
    issuedEpoch.current = e
    releaseOwnedSession()
    setState((s) => ({
      ...s,
      session: null,
      compressPhase: "reading",
      error: null,
    }))
    if (items.length === 1 && items[0].kind === "text") {
      worker.postMessage({
        jobId: e,
        text: items[0].content,
        name: items[0].name,
      })
    } else {
      worker.postMessage({ jobId: e, files: itemsToFiles(items) })
    }
  }, [state.items, state.compressPhase, state.initializing, releaseOwnedSession])

  const updateConfig = useCallback(
    (patch: Partial<TransferConfig>) =>
      setState((s) => {
        const next = { ...s.config, ...patch }
        saveConfig(next)
        return { ...s, config: next }
      }),
    []
  )

  const stopPlayback = useCallback(() => {
    setState((s) => ({
      ...s,
      page: "stats",
      initializing: false,
      error: null,
    }))
  }, [])

  const openSettings = useCallback(() => {
    setState((s) => ({ ...s, settingsFrom: s.page, page: "settings" }))
  }, [])

  const closeSettings = useCallback(() => {
    setState((s) => ({ ...s, page: s.settingsFrom ?? "select", settingsFrom: null }))
  }, [])

  const closeStats = useCallback(() => {
    releaseOwnedSession()
    setState((s) => ({
      ...s,
      session: null,
      page: "select",
      prepared: null,
      initializing: false,
      error: null,
    }))
  }, [releaseOwnedSession])

  const busyLabel =
    state.compressPhase === "reading"
      ? "正在读取文件…"
      : state.initializing
      ? "正在准备编码…"
      : null

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">
          <img src={iconUrl} alt="AirFerry" />
        </div>
        <div className="app-title">
          <h1>AirFerry</h1>
        </div>
        {state.page !== "settings" && (
          <button
            type="button"
            className="btn secondary btn-sm settings-btn"
            onClick={openSettings}
            title="传输设置"
          >
            <SettingsIcon size={16} />
            <span>设置</span>
          </button>
        )}
      </header>
      {state.page !== "settings" && (
        <div className="steps">
          <div
            className={`step ${state.page === "select" ? "active" : state.session ? "done" : ""}`}
            onClick={() => state.page !== "play" && setState((s) => ({ ...s, page: "select" }))}
          >
            <span className="step-dot">1</span>
            <span className="step-label">选择文件</span>
          </div>
          <div className="step-line" />
          <div
            className={`step ${state.page === "play" ? "active" : state.page === "stats" ? "done" : ""}`}
          >
            <span className="step-dot">2</span>
            <span className="step-label">播放传输</span>
          </div>
          <div className="step-line" />
          <div
            className={`step ${state.page === "stats" ? "active" : ""}`}
          >
            <span className="step-dot">3</span>
            <span className="step-label">传输统计</span>
          </div>
        </div>
      )}
      <main className="app-main">
        {state.error && (
          <div className="error-banner" role="alert">
            {state.error}
          </div>
        )}
        {state.page === "select" && (
          <FileSelectPage
            items={state.items}
            onItemsChange={onItemsChange}
            onPlay={onPlay}
            busyLabel={busyLabel}
          />
        )}
        {state.page === "settings" && (
          <SettingsPage
            config={state.config}
            onChange={updateConfig}
            onBack={closeSettings}
          />
        )}
        {state.page === "play" && state.session && state.prepared && (
          <PlayPage
            session={state.session}
            config={state.config}
            totalBytes={state.prepared.totalBytes}
            onStop={stopPlayback}
          />
        )}
        {state.page === "stats" && state.session && (
          <StatsPage
            session={state.session}
            fileSize={state.prepared?.totalBytes ?? 0}
            onClose={closeStats}
          />
        )}
      </main>
    </div>
  )
}
