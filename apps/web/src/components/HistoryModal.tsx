/**
 * History & Resume Tasks Modal (Web Receiver).
 *
 * Displays completed reception history and in-flight/interrupted transfers,
 * allowing users to view text drafts, inspect transfer sizes, and clean up
 * OPFS/temporary storage.
 */
import { useState, useEffect, useCallback } from "react"
import {
  getReceiveHistory,
  deleteHistoryItem,
  clearAllReceiveHistory,
  type ReceiveHistoryItem,
} from "@/storage/receiveHistory"
import {
  CheckCircleIcon,
  CloseIcon,
  DeleteIcon,
  FileIcon,
  PackageIcon,
  WarningIcon,
} from "@/components/icons"

interface Props {
  isOpen: boolean
  onClose: () => void
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function HistoryModal({ isOpen, onClose }: Props) {
  const [items, setItems] = useState<ReceiveHistoryItem[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const reload = useCallback(() => {
    setItems(getReceiveHistory())
  }, [])

  useEffect(() => {
    if (isOpen) {
      reload()
    }
  }, [isOpen, reload])

  if (!isOpen) return null

  const handleDelete = async (id: string) => {
    await deleteHistoryItem(id)
    reload()
  }

  const handleClearAll = async () => {
    if (window.confirm("确定要清空全部接收历史并清除所有未完成的断点缓存吗？")) {
      await clearAllReceiveHistory()
      reload()
    }
  }

  const handleCopyText = (id: string, text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedId(id)
        setTimeout(() => setCopiedId(null), 1500)
      })
      .catch(() => {
        setCopiedId(null)
        alert("复制失败：浏览器未授权剪贴板，请手动选择文本复制。")
      })
  }

  const pendingCount = items.filter((it) => it.status === "partial").length

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-wrap">
            <h3>接收历史与断点任务</h3>
            {pendingCount > 0 && (
              <span className="badge warning">{pendingCount} 个未完成断点</span>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="modal-body">
          {items.length === 0 ? (
            <div className="empty-history">
              <p>暂无接收记录</p>
              <span className="sub">扫描二维码接收到的文件或文本将记录在此</span>
            </div>
          ) : (
            <div className="history-list">
              {items.map((it) => {
                const isPartial = it.status === "partial"
                const pct =
                  it.totalChunks > 0
                    ? Math.min(100, Math.round((it.completedChunks / it.totalChunks) * 100))
                    : 0

                return (
                  <div key={it.id} className={`history-card ${isPartial ? "card-partial" : ""}`}>
                    <div className="history-card-header">
                      <div className="history-type-icon">
                        {it.kind === "text" ? (
                          <span className="type-badge text">文</span>
                        ) : it.kind === "bundle" ? (
                          <PackageIcon size={16} />
                        ) : (
                          <FileIcon size={16} />
                        )}
                      </div>
                      <div className="history-title-area">
                        <div className="history-name" title={it.title}>
                          {it.title}
                        </div>
                        <div className="history-meta">
                          <span>{formatBytes(it.totalRawSize)}</span>
                          <span>•</span>
                          <span>{formatDate(it.timestamp)}</span>
                          {it.entryCount > 1 && <span>• {it.entryCount} 个文件</span>}
                        </div>
                      </div>
                      <button
                        className="btn-text delete-btn"
                        onClick={() => handleDelete(it.id)}
                        title="删除记录"
                      >
                        <DeleteIcon size={14} />
                      </button>
                    </div>

                    {isPartial ? (
                      <div className="partial-status-box">
                        <div className="partial-progress-row">
                          <span className="partial-tag">
                            <WarningIcon size={12} /> 未完成 ({it.completedChunks}/{it.totalChunks} 块, {pct}%)
                          </span>
                          <span className="hint-text">对准原二维码即可接续</span>
                        </div>
                        <div className="progress-track-sm">
                          <div className="progress-bar" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    ) : (
                      it.textContent && (
                        <div className="history-text-preview">
                          <pre>{it.textContent.slice(0, 150)}{it.textContent.length > 150 ? "..." : ""}</pre>
                          <button
                            className="btn btn-xs"
                            onClick={() => handleCopyText(it.id, it.textContent || "")}
                          >
                            {copiedId === it.id ? "已复制" : "复制"}
                          </button>
                        </div>
                      )
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {items.length > 0 && (
          <div className="modal-footer">
            <button className="btn btn-sm danger" onClick={handleClearAll}>
              清空全部记录与断点
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
