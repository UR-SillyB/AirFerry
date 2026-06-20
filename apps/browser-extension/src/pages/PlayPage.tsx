/** Page 3: live QR video stream playback. */
import { useState } from "react"
import { QrStream, type QrStreamStats } from "@/components/QrStream"
import type { SenderSessionWasm } from "@/wasm/loader"
import type { TransferConfig } from "@/types"

interface Props {
  session: SenderSessionWasm
  config: TransferConfig
  sessionId: { lo: bigint; hi: bigint }
  /** Total bytes to send (compressed payload). */
  totalBytes: number
}

function hex(lo: bigint, hi: bigint): string {
  // Render as 32-hex-digit string.
  const lo32 = lo.toString(16).padStart(16, "0")
  const hi32 = hi.toString(16).padStart(16, "0")
  return `${hi32}${lo32}`
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—"
  const s = Math.ceil(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return `${m}m ${rem}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function PlayPage({ session, config, sessionId, totalBytes }: Props) {
  const [stats, setStats] = useState<QrStreamStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Total bytes including redundancy overhead (sender emits K source + K*redundancy/100 repair).
  const totalWithRedundancy = totalBytes * (1 + config.redundancyPct / 100)
  // The sender loops its emission plan forever so late receivers can rejoin.
  // Progress is therefore within a single pass; once a full pass completes the
  // stream keeps looping ("持续传输中") and we switch to showing loop count
  // instead of a stuck 100% bar.
  const passPct = stats && totalWithRedundancy > 0
    ? (stats.bytes / totalWithRedundancy) * 100
    : 0
  const loopsDone = Math.floor(passPct / 100)
  const progressPct = Math.min(100, passPct)
  const remainingInPass = Math.max(0, totalWithRedundancy - (stats?.bytes ?? 0) + loopsDone * totalWithRedundancy)
  const etaSeconds = stats && stats.throughputBps > 0
    ? remainingInPass / stats.throughputBps
    : 0

  return (
    <div className="page">
      <h2>正在播放</h2>
      {error && <p className="error">{error}</p>}
      <QrStream
        session={session}
        fps={config.fps}
        brightness={config.brightness}
        autoOptimize={config.autoOptimize}
        multiQr={config.multiQr}
        onStats={setStats}
        onError={(e) => setError(e.message)}
      />
      {stats && (
        <div className="stats-bar">
          <div className="stat-item">
            <div className="stat-value">{stats.fps.toFixed(0)}</div>
            <div className="stat-label">符号/秒</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{(stats.throughputBps / 1024).toFixed(1)}</div>
            <div className="stat-label">KB/s</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">
              {loopsDone > 0 ? `循环×${loopsDone}` : `${progressPct.toFixed(0)}%`}
            </div>
            <div className="stat-label">进度</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{loopsDone > 0 ? "持续中" : formatDuration(etaSeconds)}</div>
            <div className="stat-label">预计剩余</div>
          </div>
        </div>
      )}
    </div>
  )
}
