/**
 * Settings page: transfer parameters (redundancy, fps, symbol size, brightness).
 * Opened from the header gear; changes persist to localStorage immediately and
 * apply to the next playback (fps / brightness / multi-QR / dither also affect
 * any stream already playing).
 */
import { ChevronLeftIcon } from "@/components/icons"
import type { TransferConfig } from "@/types"
import { SPEED_PRESETS, presetForSymbolSize } from "@/types"

interface Props {
  config: TransferConfig
  onChange: (patch: Partial<TransferConfig>) => void
  onBack: () => void
}

export function SettingsPage({ config, onChange, onBack }: Props) {
  return (
    <div className="page">
      <div className="settings-top">
        <button type="button" className="btn secondary btn-sm" onClick={onBack}>
          <ChevronLeftIcon size={16} /> 返回
        </button>
      </div>
      <h2>传输设置</h2>
      <p className="page-desc">参数会自动保存，对下一次播放生效</p>

      <div className="field">
        <div className="field-label">
          <span>冗余率 <span className="muted">(5%–50%)</span></span>
          <span className="field-value">{config.redundancyPct}%</span>
        </div>
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
      </div>

      <div className="field">
        <label>帧率</label>
        <select
          value={config.fps}
          onChange={(e) => onChange({ fps: Number(e.target.value) })}
        >
          <option value={15}>15 FPS（低端设备）</option>
          <option value={20}>20 FPS（大码稳定）</option>
          <option value={30}>30 FPS</option>
          <option value={45}>45 FPS（推荐）</option>
          <option value={60}>60 FPS（高速）</option>
          <option value={90}>90 FPS（高刷屏）</option>
          <option value={120}>120 FPS（高刷屏）</option>
          <option value={0}>跟随屏幕刷新（不跳过可见帧）</option>
        </select>
      </div>

      <div className="field">
        <div className="field-label">
          <span>亮度</span>
          <span className="field-value">{config.brightness.toFixed(2)}x</span>
        </div>
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
        <label className="field-check">
          <input
            type="checkbox"
            checked={config.autoOptimize}
            onChange={(e) => onChange({ autoOptimize: e.target.checked })}
          />
          自动优化亮度 / 对比度 / 边距
        </label>
      </div>

      <div className="field">
        <label>同屏二维码数（多码加速）</label>
        <select
          value={config.multiQr > 1 ? 4 : 1}
          onChange={(e) => onChange({ multiQr: Number(e.target.value) > 1 ? 4 : 1 })}
        >
          <option value={1}>关闭（每帧 1 个，最稳）</option>
          <option value={4}>开启（每帧 4 个，~4× 吞吐）</option>
        </select>
      </div>

      <div className="field">
        <label className="field-check">
          <input
            type="checkbox"
            checked={config.ditherJitter}
            onChange={(e) => onChange({ ditherJitter: e.target.checked })}
          />
          亚像素抖动（防摩尔纹）
        </label>
      </div>
    </div>
  )
}
