/** Sender-side AF2 entry path helpers. */

/**
 * Canonicalize a browser-provided file/relative path before it enters the AF2
 * manifest. AF2 uses forward slashes and NFC Unicode paths; parent traversal is
 * never a valid sender path.
 */
export function normalizeSenderPath(raw: string, fallback = "unnamed"): string {
  const normalized = (raw || fallback).replace(/\\/g, "/").normalize("NFC")
  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".")
  if (parts.some((part) => part === "..")) {
    throw new Error(`非法相对路径（包含 ..）: ${raw}`)
  }
  return parts.join("/") || fallback
}

/**
 * One file travelling from the main thread into the compress worker.
 *
 * `path` is REQUIRED in practice for anything picked via directory picker /
 * drag-and-drop walk: a JS-level `webkitRelativePath` own-property override
 * does NOT survive postMessage — the structured clone of a File serializes
 * the browser-native internal relative-path field (empty for those files),
 * so the hierarchy must travel as a sibling string field.
 */
export interface SenderFileItem {
  file: File
  /** Main-thread-resolved sender path (directory picks / drop walks). */
  path?: string
}

/**
 * Prefer the explicitly carried path, then the browser-native relative path,
 * then the bare file name. Plain files fall back to `file.name`.
 */
export function senderPathForFile(
  file: Pick<File, "name"> & { webkitRelativePath?: string },
  overridePath?: string
): string {
  const rel = (overridePath ?? file.webkitRelativePath)?.trim()
  return normalizeSenderPath(rel || file.name || "unnamed")
}

/** Add a numeric suffix to the basename while preserving its parent directory. */
export function uniqueSenderPath(used: Set<string>, requestedPath: string): string {
  const path = normalizeSenderPath(requestedPath)
  if (!used.has(path)) return path

  const slash = path.lastIndexOf("/")
  const dir = slash >= 0 ? path.slice(0, slash + 1) : ""
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  let i = 1
  while (used.has(`${dir}${stem} (${i})${ext}`)) i++
  return `${dir}${stem} (${i})${ext}`
}
