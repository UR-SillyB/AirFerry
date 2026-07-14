/**
 * Full-screen overlay shown while the sender prepares the chosen file(s) for
 * transfer (read → optional bundle → compress → CRC/fingerprint). The prep runs
 * in a dedicated worker so this overlay animates smoothly even during the slow
 * level-9 xz pass — that's the whole point of offloading to a worker (a
 * main-thread overlay would itself freeze during compression).
 *
 * ## Step list + live timing
 *
 * The compressors are synchronous WASM, so we can't report a percentage
 * mid-compress — only which phase we just entered. Rather than a bare spinner,
 * we render the phases as an **ordered step list**: each step shows its state
 * (✓ done / ⏳ active pulsing / ○ pending) and a live elapsed-seconds counter
 * that ticks every 100ms while the step is active and freezes when it
 * completes. The current step pulses so the user can see exactly where the
 * pipeline is and how long each stage took.
 *
 * `bundling` is shown only for multi-file selections; single-file transfers
 * hide that step (the worker never emits it).
 *
 * ## Reset semantics
 *
 * All timing lives in React state keyed off [phase]. When a new transfer
 * begins, the worker re-emits "reading" (the first phase), which naturally
 * resets the list — and when the overlay is hidden (phase → null), a
 * `useEffect` clears the recorded timestamps so the next transfer starts clean.
 * Previous versions stored timestamps in `useRef`, which persisted across
 * transfers (the component never unmounts) and left stale timers / stuck steps.
 */

import { useEffect, useState } from "react"

/** The compress phases reported by the worker, in pipeline order. */
export type CompressPhase = "reading" | "bundling" | "zstd" | "xz" | "finalizing"

interface Props {
  /** Current phase (null hides the overlay). */
  phase: CompressPhase | null
  /** Display name of the transfer, for context. */
  displayName?: string
  /** Original size of the file(s), in bytes (shown for scale). */
  originalSize?: number
  /** Whether this is a multi-file bundle (controls whether the bundling step shows). */
  isBundle?: boolean
}

/** Ordered step definitions. `bundling` is conditionally shown. */
interface StepDef {
  phase: CompressPhase
  label: string
  hint?: string
}

const ALL_STEPS: StepDef[] = [
  { phase: "reading", label: "读取文件", hint: "读取选中文件到内存" },
  { phase: "bundling", label: "打包文件", hint: "合并多个文件为一次传输" },
  { phase: "zstd", label: "压缩 (zstd)", hint: "快压缩阶段，通常 1–2 秒" },
  { phase: "xz", label: "压缩 (xz)", hint: "深度压缩，文本类大文件可能需要数十秒" },
  { phase: "finalizing", label: "生成校验与指纹", hint: "计算 CRC32 并派生传输标识" },
]

/** Map a phase to its index within the (optionally bundle-filtered) step list. */
function stepOrder(isBundle: boolean): StepDef[] {
  return ALL_STEPS.filter((s) => s.phase !== "bundling" || isBundle)
}

function formatBytes(n?: number): string {
  if (n == null) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Format a duration in ms as "X.Xs" (one decimal). */
function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export function CompressProgress({ phase, displayName, originalSize, isBundle }: Props) {
  // `now` ticks every 100ms while the overlay is visible, driving the active
  // step's live elapsed counter.
  const [now, setNow] = useState(() => Date.now())

  /**
   * Wall-clock ms each phase was ENTERED. Kept in state (not ref) so a fresh
   * transfer — which re-emits "reading" — naturally rebuilds it. Cleared on
   * hide via the effect below.
   */
  const [enterMs, setEnterMs] = useState<Record<string, number>>({})
  /** Frozen duration (ms) of each COMPLETED phase. */
  const [doneMs, setDoneMs] = useState<Record<string, number>>({})
  /** Last phase seen, to detect a phase advance and finalize the previous one. */
  const [prevPhase, setPrevPhase] = useState<CompressPhase | null>(null)

  // 100ms ticker, only while visible.
  useEffect(() => {
    if (!phase) return
    const id = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(id)
  }, [phase])

  // Track phase transitions: stamp the enter time of a new phase, and freeze
  // the just-left phase's duration.
  useEffect(() => {
    if (!phase) return
    setPrevPhase((prev) => {
      // Finalize the previous phase's duration when we advance to a new one.
      if (prev && prev !== phase) {
        const enter = enterMs[prev]
        if (enter != null && doneMs[prev] == null) {
          setDoneMs((d) => ({ ...d, [prev]: Date.now() - enter }))
        }
      }
      // Stamp this phase's enter time if not already recorded.
      setEnterMs((m) => (m[phase] == null ? { ...m, [phase]: Date.now() } : m))
      return phase
    })
  }, [phase, enterMs, doneMs])

  // RESET when the overlay hides: a fresh transfer must start with empty
  // timing. Previous versions used useRef, which survived across transfers and
  // left stale/frozen timers.
  useEffect(() => {
    if (!phase) {
      setEnterMs({})
      setDoneMs({})
      setPrevPhase(null)
    }
  }, [phase])

  if (!phase) return null

  const steps = stepOrder(!!isBundle)
  const activeIdx = steps.findIndex((s) => s.phase === phase)
  const activeHint = activeIdx >= 0 ? steps[activeIdx].hint : undefined

  return (
    <div className="compress-overlay">
      <div className="compress-card">
        <div className="compress-spinner" aria-label="处理中" />
        <div className="compress-title">正在准备传输</div>
        {displayName && (
          <div className="compress-sub">
            {displayName}
            {originalSize ? ` · ${formatBytes(originalSize)}` : ""}
          </div>
        )}

        <ul className="compress-steps">
          {steps.map((s, i) => {
            // A step past the active one that never ran (e.g. xz when zstd
            // decided the file was already compressed and early-exited) is
            // "skipped", not "pending" — otherwise it reads as "stuck". We
            // detect this once the pipeline has moved to a later phase
            // (finalizing) without xz ever being entered.
            let state: "done" | "active" | "pending" | "skipped"
            if (i < activeIdx) {
              // A prior step we never entered (no enterMs) was skipped.
              state = enterMs[s.phase] == null ? "skipped" : "done"
            } else if (i === activeIdx) {
              state = "active"
            } else {
              state = "pending"
            }
            const icon =
              state === "done" ? "✓" :
              state === "skipped" ? "–" :
              state === "active" ? "⏳" : "○"
            // Done → frozen finalized duration; skipped → blank; active → live;
            // pending → blank.
            const dur =
              state === "done"
                ? doneMs[s.phase]
                : state === "active"
                  ? now - (enterMs[s.phase] ?? now)
                  : undefined
            return (
              <li key={s.phase} className={`compress-step ${state}`}>
                <span className="compress-step-icon">{icon}</span>
                <span className="compress-step-label">{s.label}</span>
                <span className="compress-step-time">
                  {dur != null ? formatDuration(dur) : ""}
                </span>
              </li>
            )
          })}
        </ul>

        {activeHint && <div className="compress-hint">{activeHint}</div>}
      </div>
    </div>
  )
}
