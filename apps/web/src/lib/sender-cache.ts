/**
 * §9.3 sender resend-cache (SPEC §10.2): stores the encoded AF2 Manifest of a
 * transfer keyed by its content fingerprint, so a resend of the same
 * selection skips the whole BLAKE3 hash pass (`SenderBuilderWasm.build_cached`).
 *
 * The cache is ADVISORY by design:
 * - key = SHA-256 over sorted `(kind, path, fingerprint)` + `chunk_raw_size`,
 *   where each item fingerprint is `(size, mtime)` for files and
 *   `(size, fnv1a(content))` for text (see compress.worker.ts). mtime is a
 *   LOCAL invalidation key — it never enters protocol identity.
 * - a stale hit (content changed without size/mtime changing) produces a
 *   transfer whose receivers fail §13 verification, never a wire crash;
 * - crypto.subtle is unavailable on some standalone `file://` contexts —
 *   the cache then degrades to a miss and the full hash pass runs.
 *
 * Cache hygiene: ≤ MAX_ENTRIES, entries older than MAX_AGE_MS pruned on put.
 */

import type { PreparedItem } from "../workers/compress.worker"

const DB_NAME = "airferry-sender-cache"
const STORE = "manifest-cache"
const MAX_ENTRIES = 40
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface CachedManifest {
  manifestHex: string
  chunkRawSize: number
}

// Reuse one connection: every call used to open (and leak) a fresh
// IndexedDB connection for the same database.
let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: "key" })
        store.createIndex("cachedAt", "cachedAt")
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
    })
  }
  return dbPromise
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function getOne(database: IDBDatabase, key: string): Promise<CachedManifest | null> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, "readonly")
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => {
      const rec = req.result as
        | { manifestHex?: string; chunkRawSize?: number }
        | undefined
      resolve(
        rec && typeof rec.manifestHex === "string" && typeof rec.chunkRawSize === "number"
          ? { manifestHex: rec.manifestHex, chunkRawSize: rec.chunkRawSize }
          : null
      )
    }
    req.onerror = () => reject(req.error)
  })
}

/** Look up a cached manifest for the given transfer fingerprint. */
export async function getCachedManifest(
  items: readonly PreparedItem[],
  chunkRawSize: number
): Promise<CachedManifest | null> {
  const key = await cacheKey(items, chunkRawSize)
  if (!key) return null
  try {
    const database = await db()
    return await getOne(database, key)
  } catch {
    return null // cache is advisory — never block a send on it
  }
}

/** Store the encoded manifest (from `SenderSessionWasm.manifest_json`). */
export async function putCachedManifest(
  items: readonly PreparedItem[],
  manifestHex: string,
  chunkRawSize: number
): Promise<void> {
  const key = await cacheKey(items, chunkRawSize)
  if (!key) return
  try {
    const database = await db()
    const tx = database.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    store.put({ key, manifestHex, chunkRawSize, cachedAt: Date.now() })
    await txDone(tx)
    await prune(database)
  } catch {
    // advisory — a full IndexedDB or quota failure must not fail the send
  }
}

/** Drop oldest entries past MAX_ENTRIES / MAX_AGE_MS. */
async function prune(database: IDBDatabase): Promise<void> {
  try {
    const tx = database.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    const index = store.index("cachedAt")
    const cutoff = Date.now() - MAX_AGE_MS
    const expired: IDBValidKey[] = []
    const all: IDBValidKey[] = []
    const req = index.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        // delete expired, then oldest beyond the cap
        for (const k of expired) store.delete(k)
        const excess = Math.max(0, all.length - MAX_ENTRIES)
        for (const k of all.slice(0, excess)) store.delete(k)
        return
      }
      const rec = cursor.value as { cachedAt: number }
      all.push(cursor.primaryKey)
      if (rec.cachedAt < cutoff) expired.push(cursor.primaryKey)
      cursor.continue()
    }
    // Fire-and-forget: prune failures are non-fatal
    tx.oncomplete = () => undefined
  } catch {
    // ignore
  }
}

/**
 * Transfer fingerprint: SHA-256 over sorted `(kind, path, fingerprint)` +
 * `chunk_raw_size`. Sorting makes the key independent of UI selection order —
 * the canonical content stream (and therefore the manifest) is path-sorted
 * anyway. Returns null when crypto.subtle is unavailable (then: no caching).
 */
export async function cacheKey(
  items: readonly PreparedItem[],
  chunkRawSize: number
): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const sorted = items
    .map((it) => `${it.kind}|${it.path}|${it.fingerprint}`)
    .sort()
    .join("\n")
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(`${sorted}\n${chunkRawSize}`))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}
