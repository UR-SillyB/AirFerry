/**
 * Filename helpers for text items on the select page (".txt" naming).
 * IndexedDB draft storage was removed with the unified select list UI.
 */

/** Normalize a user-entered name into a safe `*.txt` filename. */
export function normalizeDraftFilename(input: string): string {
  let s = input.trim()
  if (!s) return ""
  s = s.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ")
  if (!/\.txt$/i.test(s)) s += ".txt"
  return s
}
