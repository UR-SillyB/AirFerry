/**
 * Full-screen overlay shown while the sender prepares the chosen file(s) for
 * transfer (read → optional bundle → compress → CRC/fingerprint). The prep runs
 * in a dedicated worker so this overlay's spinner keeps animating smoothly
 * even during the slow level-9 xz pass — that's the whole point of offloading
 * to a worker (a main-thread overlay would itself freeze during compression).
 *
 * The progress is stage-based: the compressors are synchronous WASM, so we
 * can't report a percentage mid-compress, only which phase we just entered.
 */

/** The compress phases reported by the worker, in order. */
export type CompressPhase = "reading" | "bundling" | "zstd" | "xz" | "done"

interface Props {
  /** Current phase (null hides the overlay). */
  phase: CompressPhase | null
  /** Display name of the transfer, for context. */
  displayName?: string
  /** Original size of the file(s), in bytes (shown for scale). */
  originalSize?: number
}

/** Human-readable label for each phase. */
const PHASE_LABEL: Record<CompressPhase, string> = {
  reading: "正在读取文件…",
  bundling: "正在打包文件…",
  zstd: "正在压缩 (zstd)…",
  xz: "正在压缩 (xz，较慢)…",
  done: "完成",
}

/** Short hint under the spinner explaining what the slow phases mean. */
const PHASE_HINT: Partial<Record<CompressPhase, string>> = {
  zstd: "快压缩阶段，通常 1–2 秒",
  xz: "深度压缩以获得更小体积，文本类大文件可能需要数十秒，请稍候",
  bundling: "合并多个文件为一次传输",
}

function formatBytes(n?: number): string {
  if (n == null) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function CompressProgress({ phase, displayName, originalSize }: Props) {
  if (!phase || phase === "done") return null

  const hint = PHASE_HINT[phase]

  return (
    <div className="compress-overlay">
      <div className="compress-card">
        <div className="compress-spinner" aria-label="处理中" />
        <div className="compress-title">{PHASE_LABEL[phase]}</div>
        {displayName && (
          <div className="compress-sub">
            {displayName}
            {originalSize ? ` · ${formatBytes(originalSize)}` : ""}
          </div>
        )}
        {hint && <div className="compress-hint">{hint}</div>}
      </div>
    </div>
  )
}
