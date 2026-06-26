/**
 * Page 1: content selection — file (drag-drop or picker) or text.
 *
 * A top-level Tab switches between "发送文件" (file) and "发送文字" (text):
 *  - file Tab: drag-drop / folder-walk / browse (unchanged, supports multiple
 *    files and folders; ≥2 are bundled downstream).
 *  - text Tab: a textarea; the typed string is wrapped in the `ETTEXTv1` magic
 *    (`text.ts`) downstream and sent exactly like a file.
 *
 * Both kinds converge into one `PreparedPayload` after the compress worker
 * runs, so params/play/stats are shared.
 */
import { useCallback, useRef, useState } from "react"
import type { TransferKind } from "@/types"
import { TEXT_MAGIC } from "@/wasm/text"

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
  /** Text Tab: a submitted text (the "下一步" button) → triggers the worker. */
  onTextEntered: (text: string) => void
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
        <TextTab initialText={text} onSubmit={onTextEntered} />
      )}
    </div>
  )
}

/**
 * The text input surface: a textarea with a live byte estimate and a submit
 * button.
 *
 * Editing is kept LOCAL (component state) so we don't re-run the compressor on
 * every keystroke; the parent's `text` is only the *submitted* value. The
 * "下一步" button is the discrete trigger that fires `onSubmit`, mirroring how a
 * file selection is a discrete action that fires the file pipeline.
 */
function TextTab({
  initialText,
  onSubmit,
}: {
  initialText: string
  onSubmit: (text: string) => void
}) {
  const [text, setText] = useState(initialText)
  // +8 for the ETTEXTv1 magic prepended downstream.
  const payloadBytes = text.length === 0 ? 0 : utf8Bytes(text) + 8
  const charCount = [...text].length
  const canSubmit = text.trim().length > 0
  return (
    <div className="text-input-wrap">
      <textarea
        className="text-input"
        placeholder={"在此输入要发送的文字…\n\n扫码端接收后可直接复制。"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        spellCheck={false}
      />
      <div className="text-input-stats">
        <span>{charCount} 字</span>
        <span className="muted">· 约 {formatBytes(payloadBytes)}</span>
        <span className="muted">· {TEXT_MAGIC} 载荷</span>
      </div>
      <button
        className="btn primary"
        style={{ marginTop: 16 }}
        disabled={!canSubmit}
        onClick={() => onSubmit(text)}
      >
        下一步：准备传输
      </button>
    </div>
  )
}
