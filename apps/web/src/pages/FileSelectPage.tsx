/**
 * Page 1: content selection — one unified pending list.
 *
 *  - 添加文件夹（上方左侧按钮）：directory picker
 *    (showDirectoryPicker / <input webkitdirectory>) → recursively walk & append
 *  - 添加文字（上方右侧按钮）：modal → text item (keeps content string)
 *  - 添加文件（下方大拖放区 dropzone，全页拖放/点击）：append file items
 *  - 播放：explicit confirm → parent prepares & encodes, then jumps straight
 *    to the QR play page (single pure text → one UTF8_TEXT manifest entry;
 *    otherwise files + text-as-.txt → AF2 Manifest entries)
 */
import { useCallback, useEffect, useRef, useState } from "react"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  PenIcon,
  TextDocIcon,
  UploadIcon,
  XIcon,
} from "@/components/icons"
import { normalizeDraftFilename } from "@/storage/textDrafts"
import { senderPathForFile, uniqueSenderPath } from "@/lib/sender-path"
import { MAX_ORIGINAL_BYTES, MAX_ORIGINAL_MIB, type PendingItem } from "@/types"

interface Props {
  items: PendingItem[]
  onItemsChange: (items: PendingItem[]) => void
  onPlay: () => void
  /** Non-null while the parent is preparing files / initializing the encoder. */
  busyLabel: string | null
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
  return item.kind === "file" ? item.path ?? senderPathForFile(item.file) : item.name
}

/** Append files as file-items; deduplicate by the full AF2 relative path. */
function appendFiles(existing: PendingItem[], incoming: File[]): PendingItem[] {
  const used = new Set(existing.map(itemName))
  const out = [...existing]
  for (const f of incoming) {
    const originalPath = senderPathForFile(f)
    const finalPath = uniqueSenderPath(used, originalPath)
    let file = f
    if (finalPath !== originalPath) {
      const slash = finalPath.lastIndexOf("/")
      const finalName = slash >= 0 ? finalPath.slice(slash + 1) : finalPath
      file = new File([f], finalName, { type: f.type, lastModified: f.lastModified })
      Object.defineProperty(file, "webkitRelativePath", {
        value: finalPath,
        writable: false,
      })
    }
    used.add(finalPath)
    // Persist the resolved AF2 path on the item: the webkitRelativePath
    // override on the File is only readable on the main thread and is lost
    // when the File is cloned into the compress worker.
    out.push({ id: newId(), kind: "file", file, path: finalPath })
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
    const entries: FileSystemEntry[] = []
    // Chromium returns directory entries in batches (commonly 100). Keep
    // reading until an empty batch or large folders are silently truncated.
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject)
      )
      if (batch.length === 0) break
      entries.push(...batch)
    }
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

function isFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  return Array.from(dataTransfer.types).includes("Files")
}

export function FileSelectPage({ items, onItemsChange, onPlay, busyLabel }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)
  const mountedRef = useRef(true)
  const activeDropReadsRef = useRef(0)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const [dragging, setDragging] = useState(false)
  const [isReadingDrop, setIsReadingDrop] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)
  const [textOpen, setTextOpen] = useState(false)
  const [listCollapsed, setListCollapsed] = useState(true)
  /** When true, an oversized-transfer confirmation dialog is shown. */
  const [oversizeConfirm, setOversizeConfirm] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const appendIncomingFiles = useCallback(
    (incoming: File[]) => {
      if (!mountedRef.current || incoming.length === 0) return
      const next = appendFiles(itemsRef.current, incoming)
      // Publish immediately so overlapping async picker/drop completions append
      // to the newest list even before React has rendered the parent update.
      itemsRef.current = next
      onItemsChange(next)
    },
    [onItemsChange]
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

  const ingestDrop = useCallback(
    async (dataTransfer: DataTransfer) => {
      const dataItems = dataTransfer.items
      const snapshots: Array<{ entry: FileSystemEntry | null; file: File | null }> = []
      const plainFiles = Array.from(dataTransfer.files)
      let hasDirectory = false

      if (dataItems && dataItems.length > 0) {
        for (let i = 0; i < dataItems.length; i++) {
          const item = dataItems[i]
          const getEntry = item.webkitGetAsEntry
          const entry = typeof getEntry === "function" ? getEntry.call(item) : null
          // Snapshot the fallback File before the first await. Browsers may put
          // the drag data store into protected mode once the drop event returns.
          snapshots.push({ entry, file: item.getAsFile() })
          if (entry?.isDirectory) hasDirectory = true
        }
      }

      if (!hasDirectory) {
        appendIncomingFiles(plainFiles)
        return
      }

      const allFiles: File[] = []
      for (const { entry, file } of snapshots) {
        if (entry) {
          allFiles.push(...(await walkEntry(entry)))
        } else if (file) {
          // Firefox may expose a file item without Chromium's entry API.
          allFiles.push(file)
        }
      }
      appendIncomingFiles(allFiles)
    },
    [appendIncomingFiles]
  )

  useEffect(() => {
    const clearDragState = () => {
      dragDepthRef.current = 0
      setDragging(false)
    }
    const onDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      dragDepthRef.current += 1
      setDragging(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
      if (dragDepthRef.current === 0) dragDepthRef.current = 1
      setDragging(true)
    }
    const onDragLeave = (event: DragEvent) => {
      if (dragDepthRef.current === 0) return
      if (event.relatedTarget === null) {
        clearDragState()
        return
      }
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      if (dragDepthRef.current === 0 && !isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      const dataTransfer = event.dataTransfer
      clearDragState()
      if (dataTransfer) {
        setDropError(null)
        activeDropReadsRef.current += 1
        setIsReadingDrop(true)
        void ingestDrop(dataTransfer)
          .catch((error) => {
            console.warn("Unable to read dropped files:", error)
            if (mountedRef.current) {
              setDropError("无法读取拖入的文件或文件夹，请重试或使用「添加文件」。")
            }
          })
          .finally(() => {
            activeDropReadsRef.current = Math.max(0, activeDropReadsRef.current - 1)
            if (mountedRef.current && activeDropReadsRef.current === 0) {
              setIsReadingDrop(false)
            }
          })
      }
    }

    document.addEventListener("dragenter", onDragEnter, true)
    document.addEventListener("dragover", onDragOver, true)
    document.addEventListener("dragleave", onDragLeave, true)
    document.addEventListener("drop", onDrop, true)
    window.addEventListener("blur", clearDragState)
    return () => {
      document.removeEventListener("dragenter", onDragEnter, true)
      document.removeEventListener("dragover", onDragOver, true)
      document.removeEventListener("dragleave", onDragLeave, true)
      document.removeEventListener("drop", onDrop, true)
      window.removeEventListener("blur", clearDragState)
    }
  }, [ingestDrop])

  const removeItem = useCallback(
    (id: string) => {
      const next = itemsRef.current.filter((it) => it.id !== id)
      itemsRef.current = next
      onItemsChange(next)
    },
    [onItemsChange]
  )

  const clearAll = useCallback(() => {
    itemsRef.current = []
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

  /** Open a directory picker and append every file inside it (recursively). */
  const handleBrowseFolderClick = useCallback(async () => {
    const w = window as any
    if (typeof w.showDirectoryPicker === "function") {
      try {
        const dirHandle = await w.showDirectoryPicker({ mode: "read" })
        const root = dirHandle.name
        const files: File[] = []
        const walk = async (handle: any, relPath: string) => {
          const children: Array<[string, any]> = []
          for await (const [name, child] of handle.entries()) {
            children.push([name, child])
          }
          for (const [name, child] of children) {
            const childPath = relPath ? `${relPath}/${name}` : name
            if (child.kind === "file") {
              const f = await child.getFile()
              Object.defineProperty(f, "webkitRelativePath", {
                value: childPath,
                writable: false,
              })
              files.push(f)
            } else if (child.kind === "directory") {
              await walk(child, childPath)
            }
          }
        }
        await walk(dirHandle, root)
        appendIncomingFiles(files)
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.warn("Directory picker failed:", err)
          folderInputRef.current?.click()
        }
      }
    } else {
      folderInputRef.current?.click()
    }
  }, [appendIncomingFiles])

  const handleAddText = useCallback(
    (name: string, content: string) => {
      const filename =
        normalizeDraftFilename(name) || normalizeDraftFilename(suggestTextFilename(content))
      const current = itemsRef.current
      const used = new Set(current.map(itemName))
      const unique = uniqueName(used, filename)
      const next: PendingItem[] = [
        ...current,
        { id: newId(), kind: "text", name: unique, content },
      ]
      itemsRef.current = next
      onItemsChange(next)
      setTextOpen(false)
    },
    [onItemsChange]
  )

  const busy = busyLabel != null
  const canSend = items.length > 0 && !isReadingDrop && !busy
  const sendLabel =
    busyLabel ??
    (isReadingDrop
      ? "正在读取拖入内容…"
      : !canSend
        ? "播放"
        : items.length > 1
          ? `播放（${items.length} 项）`
          : "播放")
  /** Total original bytes of the selected items (pre-compression). */
  const selectedBytes = totalSize(items)
  /**
   * AF2 itself supports much larger transfers, but the current Web sender is
   * still whole-buffered. Enforce the host cap before starting preparation so
   * the worker/WASM path cannot OOM after the user has already pressed Send.
   */
  const handleSendClick = useCallback(() => {
    // Wire the host-cap gate before file.arrayBuffer()/WASM copies begin.
    if (totalSize(itemsRef.current) > MAX_ORIGINAL_BYTES) {
      setOversizeConfirm(true)
      return
    }
    onPlay()
  }, [onPlay])

  return (
    <div className="page">
      {dragging && (
        <div className="page-drop-overlay" role="status" aria-live="polite">
          <div className="page-drop-overlay-card">
            <span className="page-drop-overlay-icon">
              <UploadIcon size={28} />
            </span>
            <strong>松开即可添加</strong>
            <span>文件或文件夹可拖到网页任意位置</span>
          </div>
        </div>
      )}
      <h2>选择要发送的内容</h2>

      <div className="select-actions">
        <button type="button" className="btn secondary select-action-btn" onClick={handleBrowseFolderClick}>
          <FolderIcon /> 添加文件夹
        </button>
        <button type="button" className="btn secondary select-action-btn" onClick={() => setTextOpen(true)}>
          <PenIcon /> 添加文字
        </button>
      </div>

      <div
        className={`dropzone ${dragging ? "drag" : ""}`}
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
        <input
          ref={folderInputRef}
          type="file"
          multiple
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          style={{ display: "none" }}
          onChange={(e) => {
            handleFiles(e.target.files)
            e.target.value = ""
          }}
        />
        <div className="dropzone-icon">
          {items.length > 0 ? <FolderIcon /> : <UploadIcon />}
        </div>
        {items.length > 0 ? (
          <>
            <p className="dropzone-title">{items.length} 项已加入列表</p>
            <p className="dropzone-hint">
              共 {formatBytes(totalSize(items))} · 点击或拖拽可继续追加
            </p>
          </>
        ) : (
          <>
            <p className="dropzone-title">点击添加文件</p>
            <p className="dropzone-hint">或拖拽文件到此处</p>
          </>
        )}
      </div>

      {isReadingDrop && (
        <p className="drop-read-status" role="status">
          正在读取拖入的文件或文件夹，请稍候…
        </p>
      )}
      {dropError && <p className="error" role="alert">{dropError}</p>}

      {items.length > 0 && (
        <>
          <div className="file-list-summary-row">
            <button
              type="button"
              className="file-list-summary"
              onClick={() => setListCollapsed((v) => !v)}
              aria-expanded={!listCollapsed}
            >
              <span className="file-list-summary-count">
                {items.length} 项 · {formatBytes(totalSize(items))}
              </span>
              <span className="file-list-summary-caret">
                {listCollapsed ? (
                  <>
                    <ChevronRightIcon size={14} /> 展开
                  </>
                ) : (
                  <>
                    <ChevronDownIcon size={14} /> 折叠
                  </>
                )}
              </span>
            </button>
            <button
              type="button"
              className="btn secondary btn-sm"
              onClick={clearAll}
            >
              清空
            </button>
          </div>
          {!listCollapsed && (
            <ul className="file-list">
              {items.map((it) => (
                <li key={it.id} className="file-list-item">
                  <span className="file-list-name">
                    <span className={`file-list-ico${it.kind === "text" ? " text-ico" : ""}`}>
                      {it.kind === "text" ? <TextDocIcon /> : <FileIcon />}
                    </span>
                    <span className="file-list-text">
                      <strong>{itemName(it)}</strong>
                      <span className="muted">
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
                    <XIcon size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <button
        type="button"
        className="btn primary page-cta"
        disabled={!canSend}
        onClick={handleSendClick}
      >
        {sendLabel}
      </button>

      {textOpen && (
        <AddTextModal onCancel={() => setTextOpen(false)} onConfirm={handleAddText} />
      )}

      {oversizeConfirm && (
        <OversizeConfirmModal
          totalMiB={selectedBytes / (1024 * 1024)}
          limitMiB={MAX_ORIGINAL_MIB}
          onCancel={() => setOversizeConfirm(false)}
        />
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
          保存为文件名（收端展示/落盘名）
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

function OversizeConfirmModal({
  totalMiB,
  limitMiB,
  onCancel,
}: {
  totalMiB: number
  limitMiB: number
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onCancel])

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal-card"
        role="alertdialog"
        aria-labelledby="oversize-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="oversize-title" className="modal-save-title">
          内容超过网页发送端上限
        </h3>
        <p className="hint" style={{ marginTop: 8 }}>
          所选内容约 <strong>{totalMiB.toFixed(1)} MiB</strong>，超过当前网页发送端
          <strong> {limitMiB} MiB</strong> 的宿主内存上限。
        </p>
        <p className="hint" style={{ marginTop: 8 }}>
          AF2 协议本身支持更大内容，接收端也采用分块落盘；但当前浏览器发送端仍需把
          所选文件读入 ArrayBuffer 并复制进 WASM，因此暂时不能安全发送超过该上限的内容。
          后续发送端改为真正流式读取后可再放宽此限制。
        </p>
        <div className="modal-actions-row">
          <button type="button" className="btn primary" onClick={onCancel}>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}
