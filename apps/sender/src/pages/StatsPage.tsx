/** Page 4: transfer statistics (file size, sent frames, fps, throughput, ETA). */
import { useEffect, useState } from "react"
import type { SenderSessionWasm } from "@/wasm/loader"

interface Props {
  session: SenderSessionWasm
  fileSize: number
}

interface LiveStats {
  frames: number
  fps: number
  throughputBps: number
  bytes: number
  elapsedMs: number
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

export function StatsPage({ session, fileSize }: Props) {
  const [stats, setStats] = useState<LiveStats | null>(null)

  useEffect(() => {
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      try {
        const raw = JSON.parse(session.stats_json())
        setStats({
          frames: raw.frames,
          fps: Number(raw.fps),
          throughputBps: Number(raw.throughput_bps),
          bytes: raw.bytes,
          elapsedMs: Number(raw.elapsed_ms)
        })
      } catch {
        /* ignore */
      }
      setTimeout(tick, 500)
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [session])

  const remainingBytes = Math.max(0, fileSize - (stats?.bytes ?? 0))
  const etaMs =
    stats && stats.throughputBps > 0
      ? (remainingBytes / stats.throughputBps) * 1000
      : null

  return (
    <div className="page">
      <h2>传输统计</h2>
      <table className="kv">
        <tbody>
          <tr>
            <td>文件大小</td>
            <td>{formatBytes(fileSize)}</td>
          </tr>
          <tr>
            <td>已发送字节</td>
            <td>{formatBytes(stats?.bytes ?? 0)}</td>
          </tr>
          <tr>
            <td>已发送帧数</td>
            <td>{stats?.frames ?? 0}</td>
          </tr>
          <tr>
            <td>FPS</td>
            <td>{(stats?.fps ?? 0).toFixed(1)}</td>
          </tr>
          <tr>
            <td>传输速率</td>
            <td>{((stats?.throughputBps ?? 0) / 1024).toFixed(1)} KB/s</td>
          </tr>
          <tr>
            <td>已用时</td>
            <td>{formatDuration(stats?.elapsedMs ?? 0)}</td>
          </tr>
          <tr>
            <td>预计剩余</td>
            <td>{etaMs != null ? formatDuration(etaMs) : "—"}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
