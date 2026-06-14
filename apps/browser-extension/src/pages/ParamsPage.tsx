/** Page 2: transfer parameters (redundancy, fps, symbol size, brightness). */
import type { TransferConfig } from "@/types"

interface Props {
  file: File | null
  compressedSize: number
  config: TransferConfig
  onChange: (patch: Partial<TransferConfig>) => void
  onStart: () => void
  /** Whether the WASM encoder is currently being initialized. */
  initializing?: boolean
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—"
  const s = Math.ceil(seconds)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return `${m} 分 ${rem} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

export function ParamsPage({ file, compressedSize, config, onChange, onStart, initializing }: Props) {
  const ratio = file && file.size > 0 ? compressedSize / file.size : 1

  // Pre-transfer ETA estimate (before encoder init).
  // Total frames ≈ source symbols × (1 + redundancy) + descriptor overhead.
  const totalSymbols = Math.ceil(compressedSize / config.symbolSize)
  const totalFrames = Math.ceil(totalSymbols * (1 + config.redundancyPct / 100))
  const estimatedSeconds = totalFrames / config.fps
  return (
    <div className="page">
      <h2>传输参数</h2>
      <table className="kv">
        <tbody>
          <tr>
            <td>文件</td>
            <td>{file?.name ?? "-"}</td>
          </tr>
          <tr>
            <td>原始大小</td>
            <td>{file ? formatBytes(file.size) : "-"}</td>
          </tr>
          <tr>
            <td>压缩后</td>
            <td>{formatBytes(compressedSize)} ({(ratio * 100).toFixed(0)}%)</td>
          </tr>
          <tr>
            <td>预计帧数</td>
            <td>{totalFrames.toLocaleString()}</td>
          </tr>
          <tr>
            <td>预计传输时间</td>
            <td>
              <strong>{formatDuration(estimatedSeconds)}</strong>
              <span className="muted"> ({config.fps}fps, {config.redundancyPct}% 冗余)</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div className="field">
        <label>
          冗余率: <strong>{config.redundancyPct}%</strong>{" "}
          <span className="muted">(5%–50%)</span>
        </label>
        <input
          type="range"
          min={5}
          max={50}
          step={5}
          value={config.redundancyPct}
          onChange={(e) => onChange({ redundancyPct: Number(e.target.value) })}
        />
      </div>

      <div className="field">
        <label>帧率</label>
        <select
          value={config.fps}
          onChange={(e) => onChange({ fps: Number(e.target.value) })}
        >
          <option value={30}>30 FPS（稳定）</option>
          <option value={60}>60 FPS（高速）</option>
        </select>
      </div>

      <div className="field">
        <label>
          亮度: <strong>{config.brightness.toFixed(2)}x</strong>
        </label>
        <input
          type="range"
          min={1}
          max={1.5}
          step={0.05}
          value={config.brightness}
          onChange={(e) => onChange({ brightness: Number(e.target.value) })}
        />
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={config.autoOptimize}
            onChange={(e) => onChange({ autoOptimize: e.target.checked })}
          />{" "}
          自动优化亮度 / 对比度 / 边距
        </label>
      </div>

      <button
        className="btn primary"
        onClick={onStart}
        disabled={initializing}
      >
        {initializing ? "正在初始化编码器…" : "开始传输"}
      </button>
    </div>
  )
}
