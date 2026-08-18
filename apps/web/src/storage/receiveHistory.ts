/**
 * Web Receiver History & Pending Transfer storage.
 *
 * Persists completed reception history and tracks in-flight/interrupted
 * AF2 transfers for resume visibility and OPFS cleanup.
 */

export interface ReceiveHistoryItem {
  id: string // transferIdHex
  title: string
  kind: "file" | "bundle" | "text"
  totalRawSize: number
  entryCount: number
  completedChunks: number
  totalChunks: number
  status: "completed" | "partial"
  timestamp: number
  textContent?: string
}

const STORAGE_KEY = "airferry_receive_history_v2"

export function getReceiveHistory(): ReceiveHistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.sort((a, b) => b.timestamp - a.timestamp)
  } catch {
    return []
  }
}

function saveHistory(items: ReceiveHistoryItem[]): void {
  try {
    // Keep up to 100 most recent history items
    const capped = items.slice(0, 100)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(capped))
  } catch {
    // localStorage quota exceeded or unavailable
  }
}

export function recordPartialTransfer(
  transferIdHex: string,
  title: string,
  totalRawSize: number,
  entryCount: number,
  completedChunks: number,
  totalChunks: number,
  kind: "file" | "bundle" | "text" = "file"
): void {
  if (!transferIdHex) return
  const list = getReceiveHistory().filter((it) => it.id !== transferIdHex)
  list.unshift({
    id: transferIdHex,
    title: title || `传输 ${transferIdHex.slice(0, 8)}`,
    kind,
    totalRawSize,
    entryCount: Math.max(1, entryCount),
    completedChunks,
    totalChunks: Math.max(1, totalChunks),
    status: "partial",
    timestamp: Date.now(),
  })
  saveHistory(list)
}

export function recordCompletedTransfer(
  transferIdHex: string,
  title: string,
  totalRawSize: number,
  entryCount: number,
  kind: "file" | "bundle" | "text",
  textContent?: string
): void {
  if (!transferIdHex) return
  const list = getReceiveHistory().filter((it) => it.id !== transferIdHex)
  list.unshift({
    id: transferIdHex,
    title: title || (kind === "text" ? "文字消息" : `文件传输 ${transferIdHex.slice(0, 8)}`),
    kind,
    totalRawSize,
    entryCount: Math.max(1, entryCount),
    completedChunks: 1,
    totalChunks: 1,
    status: "completed",
    timestamp: Date.now(),
    textContent,
  })
  saveHistory(list)
}

export async function deleteHistoryItem(id: string): Promise<void> {
  const list = getReceiveHistory().filter((it) => it.id !== id)
  saveHistory(list)

  // Also cleanup OPFS files if it was an incomplete or completed transfer
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory()
      try {
        await root.removeEntry(`af2-${id}.partial`)
      } catch {}
      try {
        await root.removeEntry(`af2-${id}.ledger.jsonl`)
      } catch {}
    }
  } catch {}
}

export async function clearAllReceiveHistory(): Promise<void> {
  const items = getReceiveHistory()
  saveHistory([])

  try {
    if (typeof navigator !== "undefined" && navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory()
      for (const item of items) {
        try {
          await root.removeEntry(`af2-${item.id}.partial`)
        } catch {}
        try {
          await root.removeEntry(`af2-${item.id}.ledger.jsonl`)
        } catch {}
      }
    }
  } catch {}
}
