/** Page 2: transfer parameters (redundancy, fps, symbol size, brightness). */
import type { TransferConfig } from "@/types"
import { SPEED_PRESETS, presetForSymbolSize } from "@/types"

interface Props {
  /** Files chosen by the user (1 or more). */
  files: File[]
  /** Display name for the transfer (single file name or "N个文件打包"). */
  displayName: string
  /** Total original (pre-compression) byte count of the transfer unit. */
  originalSize: number
  /** Compressed payload size in bytes. */
  compressedSize: number
  /** Whether the payload is a multi-file bundle. */
  isBundle: boolean
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

export function ParamsPage({
  files,
  displayName,
  originalSize,
  compressedSize,
  isBundle,
  config,
  onChange,
  onStart,
  initializing
}: Props) {
  const ratio = originalSize > 0 ? compressedSize / originalSize : 1

  // Pre-transfer ETA estimate (before encoder init).
  // Total frames ≈ source symbols × (1 + redundancy) + descriptor overhead.
  const totalSymbols = Math.ceil(compressedSize / config.symbolSize)
  const totalFrames = Math.ceil(totalSymbols * (1 + config.redundancyPct / 100))
  const estimatedSeconds = totalFrames / config.fps

  // Show the file list (collapsible-ish: first few + "还有 N 个" for bundles).
  const visibleFiles = files.slice(0, 5)
  const hiddenCount = files.length - visibleFiles.length

  return (
    <div className="page">
      <h2>传输参数</h2>
      <table className="kv">
        <tbody>
          <tr>
            <td>{isBundle ? "打包内容" : "文件"}</td>
            <td>
              {displayName}
              {isBundle && (
                <ul className="kv-file-list">
                  {visibleFiles.map((f, i) => (
                    <li key={i}>
                      <span>{f.name}</span>
                      <span className="muted"> {formatBytes(f.size)}</span>
                    </li>
                  ))}
                  {hiddenCount > 0 && (
                    <li className="muted">…还有 {hiddenCount} 个文件</li>
                  )}
                </ul>
              )}
            </td>
          </tr>
          <tr>
            <td>原始大小</td>
            <td>{formatBytes(originalSize)}</td>
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
        {/* Loss-aware tuning hint. RaptorQ needs K unique symbols/block; at a
            given loss rate L the receiver keeps ~(1-L) of each pass, so the
            redundancy should at least cover the loss to finish in one pass. */}
        <span
          className="muted"
          style={{ display: "block", marginTop: 4, lineHeight: 1.5 }}
        >
          {config.redundancyPct < 20
            ? "提示：若接收端丢帧率较高（>30%），建议将冗余率提高到 30%–50%，以减少需要重播的整轮次数。"
            : config.redundancyPct > 40
              ? "提示：冗余率较高会降低有效吞吐，仅在丢帧率很高的环境下使用。"
              : "当前冗余率适合大多数场景。"}
        </span>
      </div>

      <div className="field">
        <label>速度档位（每帧数据量）</label>
        <select
          value={presetForSymbolSize(config.symbolSize)?.id ?? "custom"}
          onChange={(e) => {
            const preset = SPEED_PRESETS.find((p) => p.id === e.target.value)
            if (preset) {
              // Apply both the symbol size and the preset's recommended fps.
              // The user can still nudge fps independently afterwards.
              onChange({ symbolSize: preset.symbolSize, fps: preset.fps })
            }
          }}
        >
          {SPEED_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {/* Shown when symbolSize is a non-preset value (e.g. legacy 1024). */}
          {!presetForSymbolSize(config.symbolSize) && (
            <option value="custom">自定义（{config.symbolSize}B）</option>
          )}
        </select>
        <span
          className="muted"
          style={{ display: "block", marginTop: 4, lineHeight: 1.5 }}
        >
          {(() => {
            const p = presetForSymbolSize(config.symbolSize)
            return p
              ? `${p.blurb}。每帧 ${config.symbolSize}B 有效载荷。`
              : "自定义符号大小。数值越大每帧携带数据越多，但 QR 越密越难扫。"
          })()}
        </span>
      </div>

      <div className="field">
        <label>帧率</label>
        <select
          value={config.fps}
          onChange={(e) => onChange({ fps: Number(e.target.value) })}
        >
          <option value={30}>30 FPS（稳定）</option>
          <option value={45}>45 FPS（推荐）</option>
          <option value={60}>60 FPS（高速）</option>
        </select>
        <span
          className="muted"
          style={{ display: "block", marginTop: 4, lineHeight: 1.5 }}
        >
          提示：接收端摄像头需以 ≥2× 发送帧率采集才能稳定抓到每个不同帧。45 FPS
          在扫描可靠性与吞吐之间较平衡；接收端开启并行解码后可尝试 60 FPS。
        </span>
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

      <div className="field">
        <label>同屏二维码数（实验性）</label>
        <select
          value={config.multiQr}
          onChange={(e) => onChange({ multiQr: Number(e.target.value) })}
        >
          <option value={1}>1 个（默认，最稳定）</option>
          <option value={2}>2 个（~2× 吞吐）</option>
          <option value={4}>4 个（~4× 吞吐）</option>
        </select>
        <span
          className="muted"
          style={{ display: "block", marginTop: 4, lineHeight: 1.5 }}
        >
          实验性功能：每帧在屏幕上同时显示多个二维码，每个携带不同的数据符号，吞吐量近似翻倍/四倍。要求接收端也开启「多二维码同屏」。多码时每个码更小、更难扫，建议同时选「稳定」速度档（512B）并近距离对准。
        </span>
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
