/**
 * Page 1: content selection — one unified pending list.
 *
 *  - 添加文件：dropzone / click / folder walk → append file items
 *  - 添加文字：modal → text item (keeps content string; not just a File)
 *  - 发送：explicit confirm → parent stages (single pure text → ETTEXTv1;
 *    otherwise files + text-as-.txt → processFiles / ETBUNDL1 when ≥2)
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { normalizeDraftFilename } from "@/storage/textDrafts"
import type { PendingItem } from "@/types"

interface Props {
  items: PendingItem[]
  onItemsChange: (items: PendingItem[]) => void
  onSend: () => void
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function itemSize(item: PendingItem): number {
  return item.kind === "file" ? item.file.size : new TextEncoder().encode(item.content).length
}

function totalSize(items: PendingItem[]): number {
  return items.reduce((sum, it) => sum + itemSize(it), 0)
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

function suggestTextFilename(content: string): string {
  const t = content.trim()
  const prefix =
    [...t]
      .slice(0, 10)
      .join("")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "文字"
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const time = `${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${prefix}_${time}`
}

function splitNameExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".")
  if (dot > 0 && dot < name.length - 1) {
    return { base: name.slice(0, dot), ext: name.slice(dot) }
  }
  return { base: name, ext: "" }
}

function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) return name
  const { base, ext } = splitNameExt(name)
  let i = 1
  while (used.has(`${base}(${i})${ext}`)) i++
  return `${base}(${i})${ext}`
}

/** UUID-ish id; avoids `crypto.randomUUID()` (Chrome 92+) for MV2 / Chrome 78+. */
function newId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID()
  }
  // RFC 4122 v4 via getRandomValues (available far earlier than randomUUID).
  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(16)
    c.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function itemName(item: PendingItem): string {
  return item.kind === "file" ? item.file.name : item.name
}

/** Append files as file-items; suffix names that already appear in the list. */
function appendFiles(existing: PendingItem[], incoming: File[]): PendingItem[] {
  const used = new Set(existing.map(itemName))
  const out = [...existing]
  for (const f of incoming) {
    let name = f.name
    let file = f
    if (used.has(name)) {
      name = uniqueName(used, name)
      file = new File([f], name, { type: f.type, lastModified: f.lastModified })
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath
      if (rel) {
        Object.defineProperty(file, "webkitRelativePath", {
          value: rel,
          writable: false,
        })
      }
    }
    used.add(name)
    out.push({ id: newId(), kind: "file", file })
  }
  return out
}

async function walkEntry(entry: FileSystemEntry): Promise<File[]> {
  const files: File[] = []
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject)
    )
    Object.defineProperty(file, "webkitRelativePath", {
      value: entry.fullPath.startsWith("/") ? entry.fullPath.slice(1) : entry.fullPath,
      writable: false,
    })
    files.push(file)
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    )
    for (const child of entries) {
      files.push(...(await walkEntry(child)))
    }
  }
  return files
}

function previewText(content: string, max = 40): string {
  const oneLine = content.replace(/\s+/g, " ").trim()
  if ([...oneLine].length <= max) return oneLine
  return [...oneLine].slice(0, max).join("") + "…"
}

export function FileSelectPage({ items, onItemsChange, onSend }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [textOpen, setTextOpen] = useState(false)

  const appendIncomingFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return
      onItemsChange(appendFiles(items, incoming))
    },
    [items, onItemsChange]
  )

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return
      const arr: File[] = []
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList.item(i)
        if (f) arr.push(f)
      }
      appendIncomingFiles(arr)
    },
    [appendIncomingFiles]
  )

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)

      const dataItems = e.dataTransfer.items
      let hasDir = false
      if (dataItems && dataItems.length > 0) {
        for (let i = 0; i < dataItems.length; i++) {
          const entry = dataItems[i].webkitGetAsEntry()
          if (entry && entry.isDirectory) {
            hasDir = true
            break
          }
        }
      }

      if (hasDir) {
        const allFiles: File[] = []
        for (let i = 0; i < dataItems.length; i++) {
          const entry = dataItems[i].webkitGetAsEntry()
          if (entry) allFiles.push(...(await walkEntry(entry)))
        }
        appendIncomingFiles(allFiles)
      } else {
        handleFiles(e.dataTransfer.files)
      }
    },
    [handleFiles, appendIncomingFiles]
  )

  const removeItem = useCallback(
    (id: string) => {
      onItemsChange(items.filter((it) => it.id !== id))
    },
    [items, onItemsChange]
  )

  const clearAll = useCallback(() => {
    onItemsChange([])
  }, [onItemsChange])

  const handleBrowseClick = useCallback(async () => {
    if ("showOpenFilePicker" in window) {
      try {
        const handles = await (window as any).showOpenFilePicker({ multiple: true })
        const selectedFiles: File[] = []
        for (const handle of handles) {
          selectedFiles.push(await handle.getFile())
        }
        appendIncomingFiles(selectedFiles)
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.warn("File System Access API failed:", err)
          fileInputRef.current?.click()
        }
      }
    } else {
      fileInputRef.current?.click()
    }
  }, [appendIncomingFiles])

  const handleAddText = useCallback(
    (name: string, content: string) => {
      const filename =
        normalizeDraftFilename(name) || normalizeDraftFilename(suggestTextFilename(content))
      const used = new Set(items.map(itemName))
      const unique = uniqueName(used, filename)
      onItemsChange([
        ...items,
        { id: newId(), kind: "text", name: unique, content },
      ])
      setTextOpen(false)
    },
    [items, onItemsChange]
  )

  const canSend = items.length > 0
  const sendLabel =
    !canSend ? "发送" : items.length > 1 ? `发送（${items.length} 项）` : "发送"

  return (
    <div className="page">
      <h2>选择要发送的内容</h2>
      <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
        添加文件或文字到列表，确认后发送（多项会打包为一次传输）
      </p>

      <div className="select-actions">
        <button type="button" className="btn secondary select-action-btn" onClick={handleBrowseClick}>
          📁 添加文件
        </button>
        <button type="button" className="btn secondary select-action-btn" onClick={() => setTextOpen(true)}>
          ✍ 添加文字
        </button>
      </div>

      <div
        className={`dropzone ${dragging ? "drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={handleBrowseClick}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            handleFiles(e.target.files)
            e.target.value = ""
          }}
        />
        <div className="dropzone-icon">{items.length > 0 ? "📦" : "📁"}</div>
        <p className="dropzone-hint">
          {items.length > 0 ? (
            <>
              <strong>{items.length} 项已加入列表</strong>
              <br />
              共 {formatBytes(totalSize(items))}
              <br />
              <span className="muted">点击或拖拽可继续追加</span>
            </>
          ) : (
            "拖拽文件或文件夹到此处，或点击「添加文件」"
          )}
        </p>
      </div>

      {items.length > 0 && (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 16,
              marginBottom: 8,
            }}
          >
            <p className="hint" style={{ margin: 0 }}>
              {items.length > 1
                ? `${items.length} 项将打包为一次传输`
                : "已就绪，点下方「发送」继续"}
            </p>
            <button
              type="button"
              className="btn secondary"
              style={{ fontSize: 12, padding: "4px 12px" }}
              onClick={clearAll}
            >
              清空
            </button>
          </div>
          <ul className="file-list">
            {items.map((it) => (
              <li key={it.id} className="file-list-item">
                <span className="file-list-name">
                  <span className="file-list-ico">{it.kind === "text" ? "📝" : "📄"}</span>
                  <span className="file-list-text">
                    <strong>{itemName(it)}</strong>
                    <span className="muted">
                      {" "}
                      {formatBytes(itemSize(it))}
                      {it.kind === "text" ? ` · ${previewText(it.content)}` : ""}
                    </span>
                  </span>
                </span>
                <button
                  type="button"
                  className="file-list-remove"
                  title="移除"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeItem(it.id)
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <button
        type="button"
        className="btn primary"
        style={{ marginTop: 20, width: "100%" }}
        disabled={!canSend}
        onClick={onSend}
      >
        {sendLabel}
      </button>

      {textOpen && (
        <AddTextModal onCancel={() => setTextOpen(false)} onConfirm={handleAddText} />
      )}
    </div>
  )
}

function AddTextModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: (name: string, content: string) => void
}) {
  const [text, setText] = useState("")
  const [name, setName] = useState("")
  const [nameTouched, setNameTouched] = useState(false)

  const canSubmit = text.trim().length > 0
  const charCount = [...text].length
  const payloadBytes = text.length === 0 ? 0 : utf8Bytes(text)
  const effectiveName = nameTouched
    ? name
    : name || (canSubmit ? suggestTextFilename(text) : "")

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onCancel])

  const submit = () => {
    if (!canSubmit) return
    const finalName =
      normalizeDraftFilename(effectiveName) ||
      normalizeDraftFilename(suggestTextFilename(text))
    onConfirm(finalName.replace(/\.txt$/i, ""), text)
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal-card modal-card-text"
        role="dialog"
        aria-labelledby="add-text-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="add-text-title" className="modal-save-title">
          添加文字
        </h3>
        <textarea
          className="text-input text-input-modal"
          placeholder="输入要发送的文字…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
          spellCheck={false}
        />
        <div className="text-input-stats">
          <span>{charCount} 字</span>
          <span className="muted">· 约 {formatBytes(payloadBytes)}</span>
        </div>

        <label
          className="hint"
          style={{ display: "block", marginTop: 12, marginBottom: 6 }}
          htmlFor="text-item-name"
        >
          保存为文件名（混发打包时使用）
        </label>
        <div className="text-draft-filename-field">
          <input
            id="text-item-name"
            className="text-draft-filename-input"
            type="text"
            value={nameTouched ? name : effectiveName}
            onChange={(e) => {
              setNameTouched(true)
              setName(e.target.value)
            }}
            aria-label="文件名"
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <span className="text-draft-filename-suffix" aria-hidden>
            .txt
          </span>
        </div>

        <div className="modal-actions-row">
          <button type="button" className="btn secondary" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>
            添加到列表
          </button>
        </div>
      </div>
    </div>
  )
}
