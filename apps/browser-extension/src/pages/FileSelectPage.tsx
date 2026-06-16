/** Page 1: file selection (drag-drop or picker). Supports multiple files. */
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

export function FileSelectPage({ files, onSelected }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return
      // Preserve order and drop any directory entries (size 0 + no type) that
      // some platforms include when dropping folders.
      const arr: File[] = []
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList.item(i)
        if (f) arr.push(f)
      }
      if (arr.length > 0) onSelected(arr)
    },
    [onSelected]
  )

  const removeFile = useCallback(
    (idx: number) => {
      onSelected(files.filter((_, i) => i !== idx))
    },
    [files, onSelected]
  )

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
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          handleFiles(e.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
      >
        {/* multiple: allow picking more than one file at once */}
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            handleFiles(e.target.files)
            // Reset so picking the same file again still fires onChange.
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
            "拖拽文件到此处，或点击选择（支持多选）"
          )}
        </p>
      </div>

      {files.length > 0 && (
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
      )}

      {files.length > 0 && (
        <p className="hint">
          {files.length > 1
            ? `已选择 ${files.length} 个文件，将打包为一次性传输。接收端合并接收后可分别保存每个文件。`
            : "文件已就绪。点击「下一步」设置传输参数，然后开始播放二维码视频流。"}
        </p>
      )}
    </div>
  )
}
