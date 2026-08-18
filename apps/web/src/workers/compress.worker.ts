/**
 * AF2 File-preparation worker.
 *
 * Reads user-selected files or text off the main thread, normalizes paths and
 * emits entries `{ kind, path, content }` ready for `SenderBuilderWasm`.
 */

/// <reference lib="webworker" />

import { senderPathForFile, uniqueSenderPath, type SenderFileItem } from "@/lib/sender-path"
import { MAX_ORIGINAL_BYTES, MAX_ORIGINAL_MIB } from "@/types"

export const KIND_FILE = 1
export const KIND_UTF8_TEXT = 2
export const KIND_DIRECTORY = 3

export interface PreparedItem {
  kind: number
  path: string
  content: ArrayBuffer
  /**
   * §9.3 resend-cache stamp for this item — the sender's local cache
   * invalidation key (SPEC §10.2: `(path, size, mtime)`; mtime is a LOCAL
   * cache key, never protocol identity). Files: `size:lastModified`.
   * Text items have no mtime, so their stamp is `t:size:fnv1a(content)`
   * (same-length edits change the hash).
   */
  fingerprint: string
}

/**
 * FNV-1a 32-bit — cheap content stamp for text items (the only input that can
 * change without changing size). Not a security primitive.
 */
function fnv1a32(bytes: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface CompressResult {
  jobId: number
  items: PreparedItem[]
  totalBytes: number
  displayName: string
}

function post(msg: unknown, transfer: Transferable[] = []): void {
  ;(postMessage as (m: unknown, transfer?: Transferable[]) => void)(msg, transfer)
}

self.addEventListener("message", async (e: MessageEvent) => {
  const data = e.data
  if (!data || typeof data !== "object") return

  if (data.type === "wasm-init") {
    post({ phase: "ready" })
    return
  }

  const { jobId, files, text, name } = data as {
    jobId: number
    files?: SenderFileItem[]
    text?: string
    name?: string
  }

  try {
    post({ phase: "reading", jobId })

    const items: PreparedItem[] = []
    let totalBytes = 0
    let displayName = "传输内容"

    if (typeof text === "string") {
      // NFC-normalize: the AF2 manifest validates paths as Unicode NFC and
      // rejects combining marks (macOS delivers NFD filenames by default).
      const cleanName = (name || "文字消息.txt").trim().normalize("NFC")
      displayName = cleanName
      const encoded = new TextEncoder().encode(text)
      if (encoded.byteLength > MAX_ORIGINAL_BYTES) {
        throw new Error(`文字内容超过当前网页发送端 ${MAX_ORIGINAL_MIB} MiB 宿主上限`)
      }
      totalBytes = encoded.byteLength
      items.push({
        kind: KIND_UTF8_TEXT,
        path: cleanName,
        content: encoded.buffer,
        fingerprint: `t:${encoded.byteLength}:${fnv1a32(encoded)}`,
      })
    } else if (Array.isArray(files) && files.length > 0) {
      const first = files[0].file
      displayName = first.name
      if (files.length > 1) {
        displayName = `${first.name} 等 ${files.length} 个文件`
      }
      const usedPaths = new Set<string>()
      for (const item of files) {
        const file = item.file
        if (file.size > MAX_ORIGINAL_BYTES || totalBytes + file.size > MAX_ORIGINAL_BYTES) {
          throw new Error(
            `所选内容超过当前网页发送端 ${MAX_ORIGINAL_MIB} MiB 宿主上限: ${file.name}`
          )
        }
        const buffer = await file.arrayBuffer()
        if (buffer.byteLength !== file.size) {
          throw new Error(`文件读取截断: ${file.name} 期望 ${file.size} 字节，实际读取 ${buffer.byteLength} 字节`)
        }
        // Directory hierarchy arrives in item.path: a webkitRelativePath
        // own-property override on the File does not survive the structured
        // clone into this worker (the clone re-serializes the browser-native
        // field, which is empty for picked/walked files).
        const filePath = uniqueSenderPath(usedPaths, senderPathForFile(file, item.path))
        usedPaths.add(filePath)
        totalBytes += buffer.byteLength
        items.push({
          kind: KIND_FILE,
          path: filePath,
          content: buffer,
          fingerprint: `${file.size}:${file.lastModified}`,
        })
      }
    }

    const transfers = items.map((it) => it.content)
    post(
      {
        phase: "done",
        jobId,
        items,
        totalBytes,
        displayName,
      },
      transfers
    )
  } catch (err: unknown) {
    post({
      phase: "error",
      message: err instanceof Error ? err.message : String(err),
      jobId,
    })
  }
})
