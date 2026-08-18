/** Page 3: live QR video stream playback (AF2 automatic playlist). */
import { useState } from "react"
import { QrStream, type QrStreamStats } from "@/components/QrStream"
import type { SenderSessionWasm } from "@/wasm/loader"
import type { TransferConfig } from "@/types"

interface Props {
  session: SenderSessionWasm
  config: TransferConfig
  totalBytes: number
  onStop: () => void
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

export function PlayPage({
  session,
  config,
  totalBytes,
  onStop,
}: Props) {
  const [stats, setStats] = useState<QrStreamStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Total bytes including redundancy overhead estimate (K source + K*redundancy/100 repair).
  const totalWithRedundancy = totalBytes * (1 + config.redundancyPct / 100)
  const passPct =
    stats && totalWithRedundancy > 0
      ? (stats.bytes / totalWithRedundancy) * 100
      : 0
  const progressPct = Math.min(100, passPct)
  const supplementing = passPct >= 100
  const remainingInPass = Math.max(0, totalWithRedundancy - (stats?.bytes ?? 0))
  const etaSeconds =
    stats && stats.throughputBps > 0
      ? remainingInPass / stats.throughputBps
      : 0

  return (
    <div className="page">
      <h2>正在播放</h2>
      <p className="page-desc">将接收端摄像头对准屏幕，保持画面完整可见</p>

      {error && <p className="error">{error}</p>}

      <QrStream
        session={session}
        fps={config.fps}
        brightness={config.brightness}
        autoOptimize={config.autoOptimize}
        multiQr={config.multiQr}
        ditherJitter={config.ditherJitter}
        onStop={onStop}
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
              {supplementing ? "补码中" : `${progressPct.toFixed(0)}%`}
            </div>
            <div className="stat-label">估算进度</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{supplementing ? "持续中" : formatDuration(etaSeconds)}</div>
            <div className="stat-label">预计剩余</div>
          </div>
        </div>
      )}
    </div>
  )
}
