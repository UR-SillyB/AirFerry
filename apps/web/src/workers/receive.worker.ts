/**
 * AF2 Receive worker (with §12 OPFS bounded-memory spill + crash-safe resume).
 *
 * Ingests AF2 frame byte arrays into `ReceiverSessionWasm`, spills completed
 * chunks to Origin Private File System (`af2-<tid>.partial`) via synchronous
 * access handles, journals completed bits to `af2-<tid>.ledger.jsonl`, and
 * materializes entries at completion without holding the full canonical stream
 * in memory. Falls back to an in-memory Map when OPFS is unavailable.
 */

/// <reference lib="webworker" />

import { ReceiverSessionWasm, ensureWasm } from "@/wasm/loader"
import { ChunkStore, OpfsJournal, sweepOrphanPartials } from "./receive-storage"

export const KIND_FILE = 1
export const KIND_UTF8_TEXT = 2
export const KIND_DIRECTORY = 3

const TEXT_UI_MAX_BYTES = 8 * 1024 * 1024

export interface ManifestEntryDto {
  kind: number
  path: string
  /** §7.2 save-time sanitized name (equals path when nothing needed fixing). */
  save_path?: string
  offset: number
  size: number
}

export interface MetaInfo {
  transferIdHex: string
  contentIdHex: string
  totalRawSize: number
  entryCount: number
  chunkCount: number
  chunkRawSize: number
  /** Wire symbol size T observed by the Rust receiver (0 before lock). */
  symbolSize: number
  metaConfirmed: boolean
  /** v1-magic frames rejected so far; > 0 ⇒ the peer runs protocol 1. */
  legacyPeerFrames: number
  /** Canonical ROOT frame bytes re-encoded for the §12 resume ledger. */
  rootFrameHex: string
  entries: ManifestEntryDto[]
}

export interface RecoveredText {
  kind: "text"
  text: string
  validUtf8: boolean
  name?: string
}

export interface RecoveredFile {
  kind: "file"
  name: string
  data: Blob
}

export interface RecoveredBundle {
  kind: "bundle"
  entries: RecoveredFile[]
}

export type Recovered = RecoveredText | RecoveredFile | RecoveredBundle

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let session: ReceiverSessionWasm | null = null
let activeJobId = -1
let lastMetaSent = false
let totalAcceptedSymbols = 0
let opfsDirHandle: FileSystemDirectoryHandle | null = null
let chunkStore = new ChunkStore()
let journal = new OpfsJournal()
let pendingReverify: Set<number> | null = null
let resumeChecked = false

async function getOpfsDir(): Promise<FileSystemDirectoryHandle | null> {
  if (opfsDirHandle) return opfsDirHandle
  try {
    if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function") {
      opfsDirHandle = await navigator.storage.getDirectory()
      return opfsDirHandle
    }
  } catch {}
  return null
}

function post(msg: unknown, transfer: Transferable[] = []): void {
  ;(postMessage as (m: unknown, transfer?: Transferable[]) => void)(msg, transfer)
}

async function dropSession(): Promise<void> {
  if (session) {
    try {
      session.free()
    } catch (_) {}
    session = null
  }
  lastMetaSent = false
  totalAcceptedSymbols = 0
  pendingReverify = null
  await chunkStore.discard()
  await journal.discard()
}

function readMeta(s: ReceiverSessionWasm): MetaInfo {
  const snap = JSON.parse(s.snapshot_json()) as {
    schema_version: number
    meta_confirmed: boolean
    transfer_id_hex: string
    content_id_hex: string
    root_frame_hex?: string
    total_raw_size: number
    entry_count: number
    chunk_count: number
    chunk_raw_size: number
    symbol_size?: number
    legacy_peer_frames?: number
    entries?: ManifestEntryDto[]
  }
  return {
    transferIdHex: snap.transfer_id_hex || "",
    contentIdHex: snap.content_id_hex || "",
    totalRawSize: Number(snap.total_raw_size || 0),
    entryCount: snap.entry_count || 0,
    chunkCount: snap.chunk_count || 0,
    chunkRawSize: snap.chunk_raw_size || 0,
    symbolSize: Number(snap.symbol_size || 0),
    metaConfirmed: snap.meta_confirmed === true,
    legacyPeerFrames: Number(snap.legacy_peer_frames || 0),
    rootFrameHex: snap.root_frame_hex || "",
    entries: Array.isArray(snap.entries) ? snap.entries : [],
  }
}

async function tryResume(): Promise<void> {
  if (resumeChecked || (session && session.is_complete())) return
  resumeChecked = true
  const dir = await getOpfsDir()
  const attempted = new Set<string>()
  while (true) {
    const latest = await OpfsJournal.loadMostRecent(dir)
    if (!latest) return
    if (attempted.has(latest.transferIdHex)) return
    attempted.add(latest.transferIdHex)
    if (!session) session = new ReceiverSessionWasm()
    const ok = session.resume(latest.rootFrameBytes, new Uint32Array(latest.completed))
    if (!ok) {
      // Structurally valid JSON can still carry a semantically invalid ROOT.
      // Remove only this unusable candidate, then fall back to the next older
      // valid journal instead of letting it mask every other resumable task.
      if (dir) {
        try { await dir.removeEntry(`af2-${latest.transferIdHex}.ledger.jsonl`) } catch {}
        try { await dir.removeEntry(`af2-${latest.transferIdHex}.partial`) } catch {}
      }
      continue
    }
    // Resume must not create an empty .partial file when the durable backing
    // file has disappeared; reverification below invalidates missing bits so
    // the sender can re-supply exactly those chunks.
    await chunkStore.init(dir, latest.transferIdHex, { create: false })
    chunkStore.markResumed(latest.completed)
    pendingReverify = new Set(latest.completed)
    // Rebind without truncating the valid root header / prior commit records.
    await journal.openExisting(dir, latest.transferIdHex)
    return
  }
}

async function reverifyResumedChunks(meta: MetaInfo): Promise<void> {
  if (!pendingReverify || pendingReverify.size === 0 || !session || !meta.metaConfirmed) return
  for (const idx of Array.from(pendingReverify)) {
    const chunkBytes = chunkStore.readChunk(idx, meta.chunkRawSize, meta.totalRawSize)
    pendingReverify.delete(idx)
    if (!chunkBytes || !session.verify_chunk(idx, chunkBytes)) {
      session.invalidate_chunk(idx)
      chunkStore.invalidate(idx)
      await journal.invalidate(idx)
    }
  }
  if (pendingReverify.size === 0) pendingReverify = null
}

async function ingestBatch(frames: Uint8Array[], jobId: number): Promise<{
  complete: boolean
  acceptedCount: number
  snapshot: Record<string, unknown>
}> {
  if (!session) {
    session = new ReceiverSessionWasm()
  }
  if (!resumeChecked) {
    await tryResume()
  }

  let acceptedCount = 0
  for (const frame of frames) {
    const rawWord = session.ingest(frame)
    const word = typeof rawWord === "bigint" ? rawWord : BigInt(rawWord)
    const ERROR_RECEIVED = 0xFFFFFFFFn
    if (((word >> 32n) & 0xFFFFFFFFn) === ERROR_RECEIVED) {
      continue
    }
    const accepted = ((word >> 1n) & 1n) !== 0n
    const manifestReady = ((word >> 2n) & 1n) !== 0n
    const chunkReady = ((word >> 3n) & 1n) !== 0n
    // Bit 4 is the ONLY relock signal. The old `accepted && received === 0`
    // heuristic also matched the first accepted META frame of a §12-resumed
    // session (its received counter is still zero), spuriously deleting the
    // resumed spill/ledger and making the transfer impossible to finish.
    const relocked = ((word >> 4n) & 1n) !== 0n
    const receivedSymbols = Number((word >> 32n) & 0xFFFFFFFFn)

    if (accepted) {
      acceptedCount++
      totalAcceptedSymbols++
    }
    if (relocked) {
      // A foreign transfer owns the session now: discard old storage and journal
      await chunkStore.discard()
      await journal.discard()
      lastMetaSent = false
      lastPostedFileName = ""
      lastPostedMetaTid = ""
      totalAcceptedSymbols = 0
      pendingReverify = null
      post({ type: "relock", jobId })
    }
    // Also post initial meta when ROOT locks (entry count + total size available)
    if (accepted && !lastMetaSent) {
      maybePostMeta(jobId)
    }
    if (manifestReady) {
      const m = readMeta(session)
      await reverifyResumedChunks(m)
      maybePostMeta(jobId)
    }
    if (chunkReady) {
      const idx = session.last_chunk_index()
      const bytes = new Uint8Array(session.assemble_chunk(idx))
      if (bytes.length > 0) {
        const snap = readMeta(session)
        if (!chunkStore.has(idx)) {
          const dir = await getOpfsDir()
          await chunkStore.init(dir, snap.transferIdHex)
          const storage = chunkStore.writeChunk(idx, snap.chunkRawSize, bytes)
          // Only durable OPFS chunks belong in the crash-resume ledger. A
          // memory fallback is valid for the current session but must be
          // retransmitted after a crash.
          if (storage === "disk" && snap.rootFrameHex) {
            await journal.init(dir, snap.transferIdHex, snap.chunkRawSize, snap.rootFrameHex)
            await journal.commit(idx)
          }
        }
        session.forget_chunk(idx)
      }
      maybePostMeta(jobId)
    }
  }

  const meta = readMeta(session)
  // Completion requires the decoded Manifest (entries non-empty): the core may
  // report all chunks done BEFORE the Manifest object is recovered. Staging
  // without the entry table would fail the final gate (or emit an empty
  // bundle) — keep ingesting instead; the manifest interleave delivers it and
  // every later batch re-announces complete=true.
  const isComplete =
    meta.metaConfirmed &&
    meta.chunkCount > 0 &&
    meta.entries.length > 0 &&
    chunkStore.completedCount >= meta.chunkCount

  const t = meta.symbolSize > 0 ? meta.symbolSize : 1024
  const totalSymbols =
    meta.totalRawSize > 0 ? Math.ceil(meta.totalRawSize / t) : meta.chunkCount * 1024
  const decodedSymbols = Math.min(
    chunkStore.completedCount * Math.ceil(meta.chunkRawSize / t),
    totalSymbols
  )

  const nonDirEntries = meta.entries.filter((e) => e.kind !== KIND_DIRECTORY)
  let currentFileName = ""
  if (nonDirEntries.length === 1) {
    currentFileName = nonDirEntries[0].save_path || nonDirEntries[0].path || "文件传输"
  } else if (nonDirEntries.length > 1) {
    currentFileName = `多文件传输包 (${nonDirEntries.length} 项)`
  } else if (meta.entryCount > 1) {
    currentFileName = `多文件传输包 (${meta.entryCount} 项)`
  } else if (meta.totalRawSize > 0) {
    currentFileName = "文件传输"
  }

  const snapshot = {
    totalSymbols,
    decodedSymbols,
    receivedSymbols: totalAcceptedSymbols,
    decodedBlocks: chunkStore.completedCount,
    totalBlocks: meta.chunkCount,
    decodedFraction: meta.chunkCount > 0 ? chunkStore.completedCount / meta.chunkCount : 0,
    metaConfirmed: meta.metaConfirmed,
    symbolSize: meta.symbolSize,
    legacyPeerFrames: meta.legacyPeerFrames,
    complete: isComplete,
    fileName: currentFileName,
    fileSize: meta.totalRawSize,
    totalRawSize: meta.totalRawSize,
    transferIdHex: meta.transferIdHex,
    entryCount: meta.entryCount,
    chunkCount: meta.chunkCount,
  }

  return { complete: isComplete, acceptedCount, snapshot }
}

let lastPostedFileName = ""
let lastPostedMetaTid = ""

function maybePostMeta(jobId: number): void {
  if (!session) return
  const meta = readMeta(session)
  if (meta.totalRawSize === 0 && !meta.metaConfirmed) return

  const nonDirEntries = meta.entries.filter((e) => e.kind !== KIND_DIRECTORY)
  let fileName = "文件传输"
  if (nonDirEntries.length === 1) {
    fileName = nonDirEntries[0].save_path || nonDirEntries[0].path || "文件传输"
  } else if (nonDirEntries.length > 1) {
    fileName = `多文件传输包 (${nonDirEntries.length} 项)`
  } else if (meta.entryCount > 1) {
    fileName = `多文件传输包 (${meta.entryCount} 项)`
  }

  // Only post when we have new metadata (e.g. initial ROOT lock or refined Manifest filename)
  if (
    lastPostedMetaTid === meta.transferIdHex &&
    lastPostedFileName === fileName &&
    lastMetaSent
  ) {
    return
  }

  lastPostedMetaTid = meta.transferIdHex
  lastPostedFileName = fileName
  if (meta.metaConfirmed) {
    lastMetaSent = true
  }

  const payload = {
    type: "meta",
    fileName,
    fileSize: meta.totalRawSize,
    totalRawSize: meta.totalRawSize,
    compressedSize: meta.totalRawSize,
    transferIdHex: meta.transferIdHex,
    entryCount: meta.entryCount,
    chunkCount: Math.max(1, meta.chunkCount),
    segmentIndex: 0,
    segmentCount: Math.max(1, meta.chunkCount),
    meta: {
      fileName,
      fileSize: meta.totalRawSize,
      totalRawSize: meta.totalRawSize,
      compressedSize: meta.totalRawSize,
      transferIdHex: meta.transferIdHex,
      entryCount: meta.entryCount,
      chunkCount: Math.max(1, meta.chunkCount),
    },
    jobId,
  }
  post(payload)
}

// ---------------------------------------------------------------------------
// Worker Message Handler
// ---------------------------------------------------------------------------

// Messages must be handled strictly in arrival order. ingest batches contain
// real IO awaits (OPFS spill / journal writes); letting a later `reset` run
// while a batch is suspended would null the session mid-flight and report the
// resulting crash under the NEW job's id, killing the fresh session.
let messageChain: Promise<void> = Promise.resolve()

self.addEventListener("message", (e: MessageEvent) => {
  const data = e.data
  if (!data || typeof data !== "object") return
  messageChain = messageChain.then(() => handleMessage(data))
})

async function handleMessage(data: Record<string, unknown>): Promise<void> {

  if (data.type === "init") {
    try {
      await ensureWasm()
      await dropSession()
      // Completed transfers leave their .partial behind (delivered Blobs may
      // reference it lazily); sweep only old ledger-less backings.
      await sweepOrphanPartials(await getOpfsDir())
      resumeChecked = false
      activeJobId = typeof data.jobId === "number" ? data.jobId : 0
      post({ type: "ready", jobId: activeJobId })
      post({ type: "init_ok", jobId: activeJobId })
    } catch (err) {
      post({
        type: "error",
        message: `WASM 初始化失败: ${err instanceof Error ? err.message : String(err)}`,
        jobId: activeJobId,
      })
    }
    return
  }

  if (data.type === "reset") {
    await dropSession()
    // A completed result's Blob may still be streaming from its OPFS backing
    // file even though the UI already reset to camera. Reclaim only old
    // ledger-less spills; freshly released ones get the sweep grace period.
    await sweepOrphanPartials(await getOpfsDir())
    resumeChecked = false
    activeJobId = typeof data.jobId === "number" ? data.jobId : -1
    return
  }

  if (data.type === "ingest" || data.type === "frames") {
    const frames = (data.frames || data.payloads || []) as Uint8Array[]
    const jobId = typeof data.jobId === "number" ? data.jobId : activeJobId
    if (jobId !== activeJobId) return

    try {
      const res = await ingestBatch(frames, jobId)
      post({
        type: "status",
        complete: res.complete,
        acceptedCount: res.acceptedCount,
        snapshot: res.snapshot,
        nowMs: Date.now(),
        jobId,
      })
    } catch (err) {
      post({
        type: "error",
        message: `帧处理失败: ${err instanceof Error ? err.message : String(err)}`,
        jobId,
      })
    }
    return
  }

  if (data.type === "assemble") {
    if (!session) return
    try {
      const meta = readMeta(session)
      for (let i = 0; i < meta.chunkCount; i++) {
        if (!chunkStore.has(i)) {
          post({
            type: "error",
            message: `分块 ${i + 1}/${meta.chunkCount} 缺失，无法组装`,
            jobId: activeJobId,
          })
          return
        }
      }

      // §11/§13 Integrity Gate: walk the canonical stream one chunk at a time
      // through the shared Rust incremental final verifier. Large transfers
      // retain the same entry-hash/UTF-8/Content-ID guarantees as small ones.
      if (!session.final_verify_begin()) {
        throw new Error("传输终验初始化失败")
      }
      let finalVerifyUsable = true
      const badChunks: number[] = []
      for (let i = 0; i < meta.chunkCount; i++) {
        const chunk = chunkStore.readChunk(i, meta.chunkRawSize, meta.totalRawSize)
        if (!chunk || !session.verify_chunk(i, chunk)) {
          // Local spill corruption/missing bytes are repairable: clear all
          // three completion ledgers and resume scanning so the sender can
          // re-supply only the affected chunks. Do not tear down OPFS or the
          // good chunks already received.
          session.invalidate_chunk(i)
          chunkStore.invalidate(i)
          await journal.invalidate(i)
          badChunks.push(i)
          finalVerifyUsable = false
          continue
        }
        if (finalVerifyUsable && !session.final_verify_feed(chunk)) {
          // This is a semantic §13 failure (entry hash / UTF-8 / Content ID),
          // not evidence that this particular chunk is bad. Keep it distinct
          // from the repairable chunk-hash path.
          throw new Error("传输终验失败：条目哈希、UTF-8 或 Content ID 校验未通过")
        }
      }
      if (badChunks.length > 0) {
        post({
          type: "resupply",
          message: `检测到 ${badChunks.length} 个本地损坏/缺失分块，正在等待发送端重供…`,
          jobId: activeJobId,
        })
        return
      }
      if (!session.final_verify_finish()) {
        post({
          type: "error",
          message: "传输终验失败：条目哈希、UTF-8 或 Content ID 校验未通过",
          jobId: activeJobId,
        })
        return
      }

      // Integrity is final and ingest is stopped. Release the exclusive OPFS
      // SyncAccessHandle before materializing result Blobs so getFile().slice()
      // can stay zero/low-copy instead of retaining one ArrayBuffer per chunk.
      chunkStore.prepareBlobReads()

      // 2. Materialize entries from the Manifest entry table using save_path
      const entries = meta.entries.filter((e) => e.kind !== KIND_DIRECTORY)
      let recovered: Recovered

      if (
        entries.length === 1 &&
        entries[0].kind === KIND_UTF8_TEXT &&
        entries[0].size <= TEXT_UI_MAX_BYTES
      ) {
        const e0 = entries[0]
        const blob = await chunkStore.readRangeBlob(
          e0.offset, e0.size, meta.totalRawSize, meta.chunkRawSize, "text/plain;charset=utf-8"
        )
        if (!blob) throw new Error(`无法读取条目: ${e0.save_path || e0.path}`)
        // The incremental final gate already proved strict UTF-8 validity.
        const text = await blob.text()
        recovered = {
          kind: "text",
          text,
          validUtf8: true,
          name: e0.save_path || e0.path,
        }
      } else if (entries.length === 1) {
        const e0 = entries[0]
        const blob = await chunkStore.readRangeBlob(
          e0.offset, e0.size, meta.totalRawSize, meta.chunkRawSize
        )
        if (!blob) throw new Error(`无法读取条目: ${e0.save_path || e0.path}`)
        recovered = {
          kind: "file",
          name: e0.save_path || e0.path,
          data: blob,
        }
      } else {
        const files: RecoveredFile[] = []
        for (const e of entries) {
          const blob = await chunkStore.readRangeBlob(
            e.offset, e.size, meta.totalRawSize, meta.chunkRawSize
          )
          if (!blob) throw new Error(`无法读取条目: ${e.save_path || e.path}`)
          files.push({
            kind: "file",
            name: e.save_path || e.path,
            data: blob,
          })
        }
        recovered = {
          kind: "bundle",
          entries: files,
        }
      }

      // Delivered Blobs lazily reference the OPFS .partial file — deleting it
      // now would break the user's download. Drop only the resume ledger and
      // release the exclusive handle; the .partial is removed on the next
      // init/reset (dropSession) or by the init-time orphan sweep.
      await journal.discard()
      chunkStore.release()

      post({
        type: "result",
        recovered,
        jobId: activeJobId,
      })
    } catch (err) {
      post({
        type: "error",
        message: `组装失败: ${err instanceof Error ? err.message : String(err)}`,
        jobId: activeJobId,
      })
    }
  }
}
