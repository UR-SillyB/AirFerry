/** Page 1: file selection (drag-drop or picker). */
import { useCallback, useRef, useState } from "react"

interface Props {
  file: File | null
  onSelected: (f: File) => void
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function FileSelectPage({ file, onSelected }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (files && files.length > 0) onSelected(files[0])
    },
    [onSelected]
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
        <input
          ref={inputRef}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => handleFiles(e.target.files)}
        />
        <div className="dropzone-icon">{file ? "📄" : "📁"}</div>
        <p className="dropzone-hint">
          {file ? (
            <>
              <strong>{file.name}</strong>
              <br />
              {formatBytes(file.size)}
              <br />
              <span className="muted">点击或拖拽以更换文件</span>
            </>
          ) : (
            "拖拽文件到此处，或点击选择"
          )}
        </p>
      </div>
      {file && (
        <p className="hint">
          文件已就绪。点击「下一步」设置传输参数，然后开始播放二维码视频流。
        </p>
      )}
    </div>
  )
}
