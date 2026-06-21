/** Page 1: file selection (drag-drop or picker). Supports multiple files and folders. */
import { useCallback, useRef, useState } from "react"

interface Props {
  files: File[]
  onSelected: (files: File[]) => void
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

export function FileSelectPage({ files, onSelected }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
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

  const handleDropzoneClick = useCallback(() => {
    // Trigger file selector by default
    fileInputRef.current?.click()
  }, [])

  return (
    <div className="page">
      <h2>选择要发送的文件</h2>
      <div
        className={`dropzone ${dragging ? "drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={handleDropzoneClick}
      >
        {/* File picker for individual files */}
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
        {/* Folder picker */}
        <input
          ref={folderInputRef}
          type="file"
          multiple
          /* @ts-ignore - webkitdirectory is webkit-specific but widely supported */
          webkitdirectory=""
          mozdirectory=""
          directory=""
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
                点击或拖拽以{files.length > 1 ? "追加" : "更换"}文件
              </span>
            </>
          ) : (
            "拖拽文件或文件夹到此处，或点击选择"
          )}
        </p>
        <div style={{ marginTop: 8, display: "flex", gap: 8, justifyContent: "center" }}>
          <button
            className="btn secondary"
            style={{ fontSize: 12, padding: "4px 8px" }}
            onClick={(e) => {
              e.stopPropagation()
              fileInputRef.current?.click()
            }}
          >
            选择文件
          </button>
          <button
            className="btn secondary"
            style={{ fontSize: 12, padding: "4px 8px" }}
            onClick={(e) => {
              e.stopPropagation()
              folderInputRef.current?.click()
            }}
          >
            选择文件夹
          </button>
        </div>
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
    </div>
  )
}
