/** Page 3: live QR video stream playback. */
import { useState } from "react"
import { QrStream, type QrStreamStats } from "@/components/QrStream"
import type { SenderSessionWasm } from "@/wasm/loader"
import type { TransferConfig } from "@/types"

interface Props {
  session: SenderSessionWasm
  config: TransferConfig
  sessionId: { lo: bigint; hi: bigint }
}

function hex(lo: bigint, hi: bigint): string {
  // Render as 32-hex-digit string.
  const lo32 = lo.toString(16).padStart(16, "0")
  const hi32 = hi.toString(16).padStart(16, "0")
  return `${hi32}${lo32}`
}

export function PlayPage({ session, config, sessionId }: Props) {
  const [stats, setStats] = useState<QrStreamStats | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="page">
      <h2>正在播放二维码</h2>
      <p className="hint">
        用接收端手机的摄像头对准下方二维码即可接收文件。
      </p>
      {error && <p className="error">{error}</p>}
      <QrStream
        session={session}
        fps={config.fps}
        brightness={config.brightness}
        autoOptimize={config.autoOptimize}
        onStats={setStats}
        onError={(e) => setError(e.message)}
      />
      {stats && (
        <div className="stats-bar">
          <div className="stat-item">
            <div className="stat-value">{stats.frames}</div>
            <div className="stat-label">已发帧数</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{stats.fps.toFixed(0)}</div>
            <div className="stat-label">FPS</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{(stats.throughputBps / 1024).toFixed(1)}</div>
            <div className="stat-label">KB/s</div>
          </div>
        </div>
      )}
    </div>
  )
}
