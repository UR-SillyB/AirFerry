/**
 * Persisted text drafts for the sender "发送文字" tab (IndexedDB).
 */

const DB_NAME = "airferry_sender"
const DB_VERSION = 1
const STORE = "text_drafts"
const MAX_DRAFTS = 50

export interface TextDraft {
  id: string
  name: string
  content: string
  savedAt: number
}

export function normalizeDraftFilename(input: string): string {
  let s = input.trim()
  if (!s) return ""
  s = s.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ")
  if (!/\.txt$/i.test(s)) s += ".txt"
  return s
}

function splitNameExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".")
  if (dot > 0 && dot < name.length - 1) {
    return { base: name.slice(0, dot), ext: name.slice(dot) }
  }
  return { base: name, ext: "" }
}

/** Unique bundle filenames (mirrors Android uniqueTarget in-memory). */
export function dedupeDraftFilenamesForBundle(drafts: TextDraft[]): TextDraft[] {
  const used = new Set<string>()
  return drafts.map((d) => {
    let name = d.name
    if (!used.has(name)) {
      used.add(name)
      return d
    }
    const { base, ext } = splitNameExt(name)
    let i = 1
    while (used.has(`${base}(${i})${ext}`)) i++
    name = `${base}(${i})${ext}`
    used.add(name)
    return { ...d, name }
  })
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"))
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" })
        store.createIndex("savedAt", "savedAt", { unique: false })
      }
    }
  })
}

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const store = tx.objectStore(STORE)
        const req = fn(store)
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error ?? tx.error)
        tx.oncomplete = () => db.close()
        tx.onerror = () => reject(tx.error)
      })
  )
}

export async function listDrafts(): Promise<TextDraft[]> {
  const rows = await withStore<TextDraft[]>("readonly", (store) => store.getAll())
  return rows.sort((a, b) => b.savedAt - a.savedAt)
}

export type SaveDraftOptions = { updateId?: string }

/** Saves content as typed (no trim), same bytes as single-message send. */
export async function saveDraft(
  name: string,
  content: string,
  options?: SaveDraftOptions
): Promise<TextDraft> {
  const normalized = normalizeDraftFilename(name)
  if (!normalized) throw new Error("请输入文件名")
  if (content.trim().length === 0) throw new Error("内容不能为空")

  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    const getAllReq = store.getAll()

    getAllReq.onsuccess = () => {
      const all = (getAllReq.result as TextDraft[]) ?? []
      const now = Date.now()
      const updateId = options?.updateId

      if (updateId) {
        const existing = all.find((x) => x.id === updateId)
        if (!existing) {
          reject(new Error("草稿不存在"))
          return
        }
        const draft: TextDraft = { ...existing, name: normalized, content, savedAt: now }
        const putReq = store.put(draft)
        putReq.onsuccess = () => resolve(draft)
        putReq.onerror = () => reject(putReq.error)
        return
      }

      if (all.length >= MAX_DRAFTS) {
        reject(new Error(`最多保存 ${MAX_DRAFTS} 条草稿，请先删除一些`))
        return
      }

      const draft: TextDraft = {
        id: crypto.randomUUID(),
        name: normalized,
        content,
        savedAt: now,
      }
      const putReq = store.put(draft)
      putReq.onsuccess = () => resolve(draft)
      putReq.onerror = () => reject(putReq.error)
    }

    getAllReq.onerror = () => reject(getAllReq.error ?? tx.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error)
  })
}

export async function deleteDraft(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id))
}

export function draftsToFiles(drafts: TextDraft[]): File[] {
  const ordered = [...drafts].sort((a, b) => a.savedAt - b.savedAt)
  const deduped = dedupeDraftFilenamesForBundle(ordered)
  return deduped.map((d) => {
    const blob = new Blob([d.content], { type: "text/plain;charset=utf-8" })
    return new File([blob], d.name, {
      type: "text/plain",
      lastModified: d.savedAt,
    })
  })
}
