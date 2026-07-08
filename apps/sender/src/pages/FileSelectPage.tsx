/**
 * Page 1: content selection — file (drag-drop or picker) or text.
 *
 * A top-level Tab switches between "发送文件" (file) and "发送文字" (text):
 *  - file Tab: drag-drop / folder-walk / browse (unchanged, supports multiple
 *    files and folders; ≥2 are bundled downstream).
 *  - text Tab: textarea + IndexedDB named drafts; batch send → plain .txt bundle;
 *    single send → `ETTEXTv1` (`text.ts`).
 *
 * Both kinds converge into one `PreparedPayload` after the compress worker
 * runs, so params/play/stats are shared.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { TransferKind } from "@/types"
import {
  deleteDraft,
  draftsToFiles,
  listDrafts,
  normalizeDraftFilename,
  saveDraft,
  type TextDraft,
} from "@/storage/textDrafts"

interface Props {
  /** Current transfer kind (which Tab is active). */
  kind: TransferKind
  /** Files chosen in the file Tab (empty when in the text Tab). */
  files: File[]
  /** Last submitted text from the text Tab (empty string when in the file Tab). */
  text: string
  /** Switch the active Tab. The parent clears the other kind's selection. */
  onKindChange: (kind: TransferKind) => void
  /** File Tab: a discrete file selection (replace or clear) → triggers the worker. */
  onSelected: (files: File[]) => void
  /** Text Tab: a submitted text (ETTEXTv1 single message) → triggers the worker. */
  onTextEntered: (text: string) => void
  /** Text Tab: saved drafts as plain .txt files (bundle when ≥2). */
  onSendDraftsAsFiles: (files: File[]) => void
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function totalSize(files: File[]): number {
  return files.reduce((sum, f) => sum + f.size, 0)
}

/** UTF-8 byte length of a string (TextEncoder is the cheap, correct way). */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

/** Default save name: first 10 chars of content + local timestamp. */
function suggestDraftFilename(content: string): string {
  const t = content.trim()
  const prefix =
    [...t]
      .slice(0, 10)
      .join("")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "草稿"
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const time = `${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${prefix}_${time}`
}


/**
 * Recursively walk a dropped DataTransferItem (file or directory entry) and
 * collect all File objects. This enables dragging a folder from the OS file
 * manager and having all files inside (recursively) available for transfer.
 */
async function walkEntry(entry: FileSystemEntry): Promise<File[]> {
  const files: File[] = []
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject)
    )
    // Preserve the relative path via webkitRelativePath if available
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

export function FileSelectPage({
  kind,
  files,
  text,
  onKindChange,
  onSelected,
  onTextEntered,
  onSendDraftsAsFiles,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return
      const arr: File[] = []
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList.item(i)
        if (f) arr.push(f)
      }
      if (arr.length > 0) onSelected(arr)
    },
    [onSelected]
  )

  /** Handle drag-and-drop, including folders (via DataTransferItem.webkitGetAsEntry). */
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)

      // Check if the drop contains directory entries (folder drag).
      const items = e.dataTransfer.items
      let hasDir = false
      if (items && items.length > 0) {
        for (let i = 0; i < items.length; i++) {
          const entry = items[i].webkitGetAsEntry()
          if (entry && entry.isDirectory) {
            hasDir = true
            break
          }
        }
      }

      if (hasDir) {
        // Walk folders recursively to collect all files.
        const allFiles: File[] = []
        for (let i = 0; i < items.length; i++) {
          const entry = items[i].webkitGetAsEntry()
          if (entry) {
            allFiles.push(...(await walkEntry(entry)))
          }
        }
        if (allFiles.length > 0) onSelected(allFiles)
      } else {
        // Plain file drop — use the existing FileList path.
        handleFiles(e.dataTransfer.files)
      }
    },
    [handleFiles, onSelected]
  )

  const removeFile = useCallback(
    (idx: number) => {
      onSelected(files.filter((_, i) => i !== idx))
    },
    [files, onSelected]
  )

  const clearAll = useCallback(() => {
    onSelected([])
  }, [onSelected])

  /** Try to use File System Access API if available, otherwise fallback to file input */
  const handleBrowseClick = useCallback(async () => {
    // Check if File System Access API is available
    if ('showOpenFilePicker' in window) {
      try {
        // Select files using File System Access API
        const handles = await (window as any).showOpenFilePicker({ multiple: true })
        const selectedFiles: File[] = []
        for (const handle of handles) {
          const file = await handle.getFile()
          selectedFiles.push(file)
        }
        if (selectedFiles.length > 0) onSelected(selectedFiles)
      } catch (err) {
        // User cancelled or error occurred, fallback to input
        if ((err as Error).name !== 'AbortError') {
          console.warn('File System Access API failed:', err)
          fileInputRef.current?.click()
        }
      }
    } else {
      // Fallback to traditional file input
      fileInputRef.current?.click()
    }
  }, [onSelected])

  return (
    <div className="page">
      <h2>选择要发送的内容</h2>

      {/* Tab switch: file vs text. Both kinds share the downstream pipeline,
          this only chooses the input surface. */}
      <div className="kind-tabs">
        <button
          className={`kind-tab ${kind === "file" ? "active" : ""}`}
          onClick={() => onKindChange("file")}
        >
          📁 发送文件
        </button>
        <button
          className={`kind-tab ${kind === "text" ? "active" : ""}`}
          onClick={() => onKindChange("text")}
        >
          ✍ 发送文字
        </button>
      </div>

      {kind === "file" ? (
        <>
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
            {/* Fallback file input for browsers without File System Access API */}
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
            <div className="dropzone-icon">{files.length > 0 ? "📦" : "📁"}</div>
            <p className="dropzone-hint">
              {files.length > 0 ? (
                <>
                  <strong>{files.length} 个文件</strong>
                  <br />
                  共 {formatBytes(totalSize(files))}
                  <br />
                  <span className="muted">
                    点击或拖拽以{files.length > 1 ? "追加" : "更换"}
                  </span>
                </>
              ) : (
                "拖拽文件或文件夹到此处，或点击浏览"
              )}
            </p>
          </div>

          {files.length > 0 && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, marginBottom: 8 }}>
                <p className="hint" style={{ margin: 0 }}>
                  {files.length > 1
                    ? `${files.length} 个文件将打包为一次性传输`
                    : "已就绪，点击下一步"}
                </p>
                <button
                  className="btn secondary"
                  style={{ fontSize: 12, padding: "4px 12px" }}
                  onClick={clearAll}
                >
                  清空
                </button>
              </div>
              <ul className="file-list">
                {files.map((f, idx) => (
                  <li key={`${f.name}-${idx}`} className="file-list-item">
                    <span className="file-list-name">
                      <span className="file-list-ico">{files.length > 1 ? "📄" : "📄"}</span>
                      <span className="file-list-text">
                        <strong>{f.name}</strong>
                        <span className="muted"> {formatBytes(f.size)}</span>
                      </span>
                    </span>
                    {files.length > 1 && (
                      <button
                        className="file-list-remove"
                        title="移除"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeFile(idx)
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <TextTab
          initialText={text}
          onSubmit={onTextEntered}
          onSendDraftsAsFiles={onSendDraftsAsFiles}
        />
      )}
    </div>
  )
}

/**
 * Text input + IndexedDB drafts. Single-message send uses ETTEXTv1; batch send
 * uses saved drafts as plain .txt files (bundle when ≥2).
 */
function TextTab({
  initialText,
  onSubmit,
  onSendDraftsAsFiles,
}: {
  initialText: string
  onSubmit: (text: string) => void
  onSendDraftsAsFiles: (files: File[]) => void
}) {
  const [text, setText] = useState(initialText)
  const [drafts, setDrafts] = useState<TextDraft[]>([])
  const [draftError, setDraftError] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState("")
  const [saving, setSaving] = useState(false)
  /** When set, save overwrites this draft instead of creating a new row. */
  const [loadedDraftId, setLoadedDraftId] = useState<string | null>(null)

  useEffect(() => {
    if (!loadedDraftId) setText(initialText)
  }, [initialText, loadedDraftId])

  const refreshDrafts = useCallback(async () => {
    try {
      setDrafts(await listDrafts())
      setDraftError(null)
    } catch (e) {
      setDraftError((e as Error).message || "无法读取草稿（可能已禁用存储）")
      setDrafts([])
    }
  }, [])

  useEffect(() => {
    void refreshDrafts()
  }, [refreshDrafts])

  useEffect(() => {
    if (!saveOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) setSaveOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [saveOpen, saving])

  const payloadBytes = text.length === 0 ? 0 : utf8Bytes(text) + 8
  const charCount = [...text].length
  const canSubmit = text.trim().length > 0
  const normalizedSaveName = normalizeDraftFilename(saveName)
  const canOpenSave = canSubmit
  const canConfirmSave = canSubmit && normalizedSaveName.length > 0

  const openSave = () => {
    const loaded = loadedDraftId ? drafts.find((d) => d.id === loadedDraftId) : undefined
    setSaveName(loaded ? loaded.name.replace(/\.txt$/i, "") : suggestDraftFilename(text))
    setSaveOpen(true)
    setDraftError(null)
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  const handleSaveConfirm = async () => {
    if (!canConfirmSave) return
    setSaving(true)
    try {
      const saved = await saveDraft(saveName, text, {
        updateId: loadedDraftId ?? undefined,
      })
      await refreshDrafts()
      setText("")
      setLoadedDraftId(null)
      setSaveOpen(false)
      setSaveName("")
    } catch (e) {
      setDraftError((e as Error).message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleRemoveDraft = async (id: string) => {
    try {
      await deleteDraft(id)
      if (loadedDraftId === id) setLoadedDraftId(null)
      await refreshDrafts()
    } catch (e) {
      setDraftError((e as Error).message || String(e))
    }
  }

  const loadDraftIntoEditor = (d: TextDraft) => {
    setText(d.content)
    setLoadedDraftId(d.id)
    setDraftError(null)
  }

  const startNewDraft = () => {
    setText("")
    setLoadedDraftId(null)
    setDraftError(null)
  }

  /**
   * Unified send:
   *  - no drafts + typed text → ETTEXTv1 single message (receiver can copy)
   *  - any draft → bundle all drafts as .txt (current typed text is folded in
   *    as a temp entry so unsaved input isn't lost on Send)
   */
  const handleSend = () => {
    const hasText = canSubmit
    const hasDrafts = drafts.length > 0
    if (!hasText && !hasDrafts) return

    if (hasText && !hasDrafts) {
      onSubmit(text)
      return
    }

    const all = hasText
      ? [
          ...drafts,
          {
            id: "__current__",
            name: "当前文字.txt",
            content: text,
            savedAt: Date.now(),
          } as TextDraft,
        ]
      : drafts
    onSendDraftsAsFiles(draftsToFiles(all))
  }

  const hasAnyContent = canSubmit || drafts.length > 0
  const sendCount = drafts.length + (canSubmit ? 1 : 0)

  return (
    <div className="text-input-wrap">
      <textarea
        className="text-input"
        placeholder={
          "在此输入要发送的文字…\n\n可保存为命名草稿；点「发送」：仅编辑区有字且无草稿时为文字消息，否则打包为 .txt。"
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        spellCheck={false}
      />
      <div className="text-input-stats">
        <span>{charCount} 字</span>
        <span className="muted">· 约 {formatBytes(payloadBytes)}</span>
      </div>

      {draftError && (
        <p className="hint" style={{ color: "var(--color-error)", marginTop: 8 }}>
          {draftError}
        </p>
      )}

      {loadedDraftId && (
        <p className="hint" style={{ marginTop: 8 }}>
          正在编辑已保存草稿 ·{" "}
          <button type="button" className="btn-link" onClick={startNewDraft}>
            新建一条
          </button>
        </p>
      )}

      <div className="text-draft-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn secondary" style={{ width: "100%" }} disabled={!canOpenSave} onClick={openSave}>
          {loadedDraftId ? "保存（覆盖当前草稿）" : "保存草稿"}
        </button>
      </div>

      <button
        className="btn primary"
        style={{ marginTop: 16, width: "100%" }}
        disabled={!hasAnyContent}
        onClick={handleSend}
        title={
          drafts.length > 0
            ? `打包 ${sendCount} 条为 .txt`
            : canSubmit
              ? "单条文字消息，接收端可复制"
              : undefined
        }
      >
        发送
      </button>

      {drafts.length > 0 && (
        <div className="text-drafts-panel">
          <div className="text-drafts-head">
            <p className="hint" style={{ margin: 0 }}>
              已保存 {drafts.length} 条 · 点击「发送」将打包为多个 .txt 文件
            </p>
          </div>
          <ul className="file-list">
            {drafts.map((d) => (
              <li
                key={d.id}
                className={`file-list-item${loadedDraftId === d.id ? " text-draft-active" : ""}`}
              >
                <button
                  type="button"
                  className="file-list-name text-draft-load"
                  onClick={() => loadDraftIntoEditor(d)}
                  title="载入到编辑区"
                >
                  <span className="file-list-ico">📝</span>
                  <span className="file-list-text">
                    <strong>{d.name}</strong>
                    <span className="muted"> {formatBytes(utf8Bytes(d.content))}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="file-list-remove"
                  title="删除草稿"
                  onClick={() => void handleRemoveDraft(d.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {saveOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => !saving && setSaveOpen(false)}>
          <div className="modal-card modal-card-save" role="dialog" aria-labelledby="save-draft-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="save-draft-title" className="modal-save-title">
              保存为
            </h3>
            <div className="text-draft-filename-field">
              <input
                id="draft-filename"
                className="text-draft-filename-input"
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                aria-label="文件名"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canConfirmSave && !saving) void handleSaveConfirm()
                }}
              />
              <span className="text-draft-filename-suffix" aria-hidden>
                .txt
              </span>
            </div>
            <div className="modal-actions-row">
              <button type="button" className="btn secondary" disabled={saving} onClick={() => setSaveOpen(false)}>
                取消
              </button>
              <button type="button" className="btn primary" disabled={!canConfirmSave || saving} onClick={() => void handleSaveConfirm()}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
