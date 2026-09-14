/// <reference lib="webworker" />

/**
 * Storage primitives used by the AF2 receive worker.
 *
 * Keep these separate from receive.worker.ts so the crash/resume behaviour can
 * be regression-tested without loading the WASM receiver in Node.
 */

export interface SyncHandleLike {
  read(buf: ArrayBufferView, options?: { at?: number }): number
  write(buf: ArrayBufferView, options?: { at?: number }): number
  flush(): void
  close(): void
  getSize(): number
}

export type ChunkStorage = "disk" | "memory"

const MAX_MEMORY_FALLBACK_BYTES = 64 * 1024 * 1024
const MAX_LEDGER_BYTES = 32 * 1024 * 1024
const MAX_ROOT_FRAME_HEX_CHARS = (26 + 2400 + 4) * 2
const MAX_CHUNK_INDEX = 131_072 - 1
const LEDGER_NAME_RE = /^af2-([0-9a-f]{32})\.ledger\.jsonl$/
const PARTIAL_NAME_RE = /^af2-([0-9a-f]{32})\.partial$/
const RELEASE_MARKER_NAME_RE = /^af2-([0-9a-f]{32})\.released$/
const LEGAL_CHUNK_RAW_SIZES = new Set([1, 2, 4, 8, 16, 32].map((mib) => mib * 1024 * 1024))
/**
 * In-process delivery timestamps for OPFS files backing lazy Blobs.  File
 * lastModified is the last chunk-write time, which can be hours old for a
 * resumed transfer that completed without writing anything new; the grace
 * period must start when ownership is released to the UI instead.
 */
const releasedBackingAt = new Map<string, number>()
const RELEASE_MARKER_SUFFIX = ".released"

export class ChunkStore {
  private memory = new Map<number, Uint8Array>()
  private memoryBytes = 0
  private diskIndices = new Set<number>()
  private opfsDir: FileSystemDirectoryHandle | null = null
  private opfsFile: FileSystemFileHandle | null = null
  private syncHandle: SyncHandleLike | null = null
  private transferId = ""
  private completedIndices = new Set<number>()
  /**
   * Last origin quota estimate (quota − usage), or null when the browser does
   * not expose navigator.storage.estimate. Used as a free-space preflight so a
   * hostile multi-gigabyte transfer fails early with the fatal error channel
   * instead of an opaque QuotaExceededError deep into the receive loop.
   * Decremented optimistically per durable write; re-estimated periodically.
   */
  private opfsFreeBytes: number | null = null
  private opfsWritesSinceEstimate = 0
  /**
   * A completed result may expose Blob slices backed by the OPFS partial.
   * Once release() hands those Blobs to the UI, a subsequent UI reset must not
   * immediately unlink the backing file while a browser download is still
   * consuming it. The orphan sweep reclaims it after a grace period instead.
   */
  private preserveReleasedBacking = false

  /**
   * Bind this store to one transfer.
   *
   * Repeated calls for the same transfer are intentionally idempotent: a
   * SyncAccessHandle is exclusive, so reacquiring it for every decoded chunk
   * can fail and orphan the still-open handle. Resume passes create=false so a
   * missing partial file is not silently recreated as an empty file.
   */
  async init(
    dir: FileSystemDirectoryHandle | null,
    transferIdHex: string,
    options: { create?: boolean } = {}
  ): Promise<void> {
    const create = options.create !== false
    const sameTransfer = this.transferId === transferIdHex && this.opfsDir === dir

    if (sameTransfer) {
      if (this.opfsFile || !create) return
      // A resume may have discovered that the backing .partial file was
      // missing. A later freshly decoded chunk is allowed to create it.
    } else {
      this.closeSyncHandle()
      this.memory.clear()
      this.memoryBytes = 0
      this.diskIndices.clear()
      this.completedIndices.clear()
      this.preserveReleasedBacking = false
      this.opfsFile = null
      this.opfsDir = dir
      this.transferId = transferIdHex
    }

    if (!dir || !transferIdHex) return
    try {
      const fileName = `af2-${transferIdHex}.partial`
      releasedBackingAt.delete(fileName)
      // A (re)activated transfer owns this backing again. Remove a prior
      // delivery marker so a later orphan sweep cannot mistake live receive
      // storage for a grace-period download.
      try { await dir.removeEntry(`af2-${transferIdHex}${RELEASE_MARKER_SUFFIX}`) } catch {}
      this.opfsFile = create
        ? await dir.getFileHandle(fileName, { create: true })
        : await dir.getFileHandle(fileName)
      // createSyncAccessHandle is exclusive and Worker-only. Acquire it once
      // per transfer and keep it until discard/relock.
      if (typeof (this.opfsFile as any).createSyncAccessHandle === "function") {
        this.syncHandle = await (this.opfsFile as any).createSyncAccessHandle()
      }
      this.opfsFreeBytes = await this.estimateOpfsFreeBytes()
      this.opfsWritesSinceEstimate = 0
    } catch {
      this.opfsFile = null
      this.syncHandle = null
    }
  }

  private async estimateOpfsFreeBytes(): Promise<number | null> {
    try {
      const est = await navigator.storage?.estimate?.()
      if (est && typeof est.quota === "number") {
        return Math.max(0, est.quota - (est.usage ?? 0))
      }
    } catch {}
    return null
  }

  writeChunk(
    index: number,
    chunkRawSize: number,
    bytes: Uint8Array,
    totalRawSize?: number,
  ): ChunkStorage {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index > MAX_CHUNK_INDEX ||
      !Number.isSafeInteger(chunkRawSize) ||
      chunkRawSize <= 0 ||
      bytes.byteLength <= 0 ||
      bytes.byteLength > chunkRawSize
    ) {
      throw new Error("AF2_STORAGE_FATAL: 分块索引或大小无效")
    }
    const at = index * chunkRawSize
    if (!Number.isSafeInteger(at)) {
      throw new Error("AF2_STORAGE_FATAL: 分块写入偏移超出安全范围")
    }
    if (totalRawSize !== undefined) {
      if (
        !Number.isSafeInteger(totalRawSize) ||
        totalRawSize <= 0 ||
        at >= totalRawSize ||
        bytes.byteLength !== Math.min(chunkRawSize, totalRawSize - at)
      ) {
        throw new Error("AF2_STORAGE_FATAL: 分块与传输几何不一致")
      }
    }
    if (this.syncHandle && chunkRawSize > 0) {
      // Free-space preflight against the last quota estimate (refreshed every
      // 64 durable writes): fail early with the fatal channel instead of an
      // opaque QuotaExceededError mid-transfer.
      if (this.opfsFreeBytes !== null && bytes.byteLength > this.opfsFreeBytes) {
        throw new Error("AF2_STORAGE_FATAL: OPFS 存储空间不足")
      }
      try {
        const written = this.syncHandle.write(bytes, { at })
        if (written !== bytes.byteLength) {
          throw new Error(`short OPFS write: ${written}/${bytes.byteLength}`)
        }
        this.syncHandle.flush()
        this.diskIndices.add(index)
        const previous = this.memory.get(index)
        if (previous) this.memoryBytes -= previous.byteLength
        this.memory.delete(index)
        this.completedIndices.add(index)
        if (this.opfsFreeBytes !== null) {
          this.opfsFreeBytes = Math.max(0, this.opfsFreeBytes - bytes.byteLength)
        }
        if (++this.opfsWritesSinceEstimate >= 64) {
          this.opfsWritesSinceEstimate = 0
          void this.estimateOpfsFreeBytes().then((free) => {
            if (free !== null) this.opfsFreeBytes = free
          })
        }
        return "disk"
      } catch {
        // Keep the known-good bytes in memory. Do not mark this chunk as
        // durable in the journal; after a crash it must be retransmitted.
      }
    }

    const previous = this.memory.get(index)
    const nextBytes = this.memoryBytes - (previous?.byteLength ?? 0) + bytes.byteLength
    if (nextBytes > MAX_MEMORY_FALLBACK_BYTES) {
      throw new Error(
        `AF2_STORAGE_FATAL: 临时存储不可用，内存回退已达到 ${MAX_MEMORY_FALLBACK_BYTES / 1024 / 1024} MiB 上限`
      )
    }
    this.memory.set(index, bytes)
    this.memoryBytes = nextBytes
    this.diskIndices.delete(index)
    this.completedIndices.add(index)
    return "memory"
  }

  readRange(offset: number, size: number, totalRawSize: number, chunkRawSize: number): Uint8Array | null {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(totalRawSize) ||
      !Number.isSafeInteger(chunkRawSize) ||
      offset < 0 ||
      size < 0 ||
      totalRawSize < 0 ||
      chunkRawSize <= 0 ||
      offset > totalRawSize ||
      size > totalRawSize - offset
    ) return null
    if (size === 0) return new Uint8Array(0)

    // Read chunk-by-chunk so a transfer can safely contain old OPFS-backed
    // chunks plus newer memory-fallback chunks after a transient write error.
    const out = new Uint8Array(size)
    let copied = 0
    while (copied < size) {
      const currentOffset = offset + copied
      const chunkIdx = Math.floor(currentOffset / chunkRawSize)
      const chunkStart = chunkIdx * chunkRawSize
      const chunkOffset = currentOffset - chunkStart
      const chunkLength = Math.min(chunkRawSize, Math.max(0, totalRawSize - chunkStart))
      if (chunkOffset >= chunkLength) return null
      const toCopy = Math.min(size - copied, chunkLength - chunkOffset)

      const memoryChunk = this.memory.get(chunkIdx)
      if (memoryChunk) {
        if (chunkOffset + toCopy > memoryChunk.byteLength) return null
        out.set(memoryChunk.subarray(chunkOffset, chunkOffset + toCopy), copied)
        copied += toCopy
        continue
      }

      if (!this.diskIndices.has(chunkIdx) || !this.syncHandle) return null
      try {
        const target = out.subarray(copied, copied + toCopy)
        const read = this.syncHandle.read(target, { at: currentOffset })
        if (read !== toCopy) return null
      } catch {
        return null
      }
      copied += toCopy
    }
    return out
  }

  readChunk(index: number, chunkRawSize: number, totalRawSize: number): Uint8Array | null {
    const off = index * chunkRawSize
    const len = Math.min(chunkRawSize, Math.max(0, totalRawSize - off))
    return this.readRange(off, len, totalRawSize, chunkRawSize)
  }

  /**
   * Build a Blob for one canonical-stream range without first allocating a
   * same-size Uint8Array. OPFS-backed spans become File.slice() parts; memory
   * fallback spans stay bounded to their existing chunk buffers.
   *
   * The returned Blob references the OPFS file lazily — the caller must keep
   * the backing .partial alive until the user has finished downloading (see
   * [release] and [sweepOrphanPartials]).
   */
  async readRangeBlob(
    offset: number,
    size: number,
    totalRawSize: number,
    chunkRawSize: number,
    type = "application/octet-stream"
  ): Promise<Blob | null> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(totalRawSize) ||
      !Number.isSafeInteger(chunkRawSize) ||
      size < 0 ||
      offset < 0 ||
      totalRawSize < 0 ||
      chunkRawSize <= 0 ||
      offset > totalRawSize ||
      size > totalRawSize - offset
    ) return null
    if (size === 0) return new Blob([], { type })

    // SyncAccessHandle has no lazy Blob view. Building a large Blob by pushing
    // one freshly allocated ArrayBuffer per disk chunk would silently turn the
    // bounded-memory receive path back into O(entry-size) memory. The normal
    // assemble flow calls prepareBlobReads() first so getFile().slice() is the
    // large-entry path; retain the sync fallback only for at-most-one-chunk
    // defensive reads.
    const allowSyncFallback = size <= chunkRawSize

    let diskFile: File | null = null
    if (this.opfsFile) {
      try {
        diskFile = await this.opfsFile.getFile()
      } catch {
        diskFile = null
      }
    }

    const parts: BlobPart[] = []
    let copied = 0
    while (copied < size) {
      const currentOffset = offset + copied
      const chunkIdx = Math.floor(currentOffset / chunkRawSize)
      const chunkStart = chunkIdx * chunkRawSize
      const chunkOffset = currentOffset - chunkStart
      const chunkLength = Math.min(chunkRawSize, Math.max(0, totalRawSize - chunkStart))
      if (chunkOffset >= chunkLength) return null
      const toCopy = Math.min(size - copied, chunkLength - chunkOffset)

      const memoryChunk = this.memory.get(chunkIdx)
      if (memoryChunk) {
        if (chunkOffset + toCopy > memoryChunk.byteLength) return null
        // TypeScript's BlobPart requires an ArrayBuffer-backed view. Copy only
        // this bounded chunk fragment, never the whole entry.
        const part = new Uint8Array(toCopy)
        part.set(memoryChunk.subarray(chunkOffset, chunkOffset + toCopy))
        parts.push(part.buffer)
      } else if (this.diskIndices.has(chunkIdx) && diskFile && diskFile.size >= currentOffset + toCopy) {
        parts.push(diskFile.slice(currentOffset, currentOffset + toCopy))
      } else if (this.diskIndices.has(chunkIdx) && this.syncHandle && allowSyncFallback) {
        // Defensive fallback for engines where getFile() is unavailable while
        // a SyncAccessHandle is open. Allocate at most one chunk fragment.
        const part = new Uint8Array(toCopy)
        try {
          if (this.syncHandle.read(part, { at: currentOffset }) !== toCopy) return null
        } catch {
          return null
        }
        parts.push(part.buffer)
      } else {
        return null
      }
      copied += toCopy
    }
    return new Blob(parts, { type })
  }

  has(index: number): boolean {
    return this.completedIndices.has(index)
  }

  /** True when this completion has a crash-resume journal-worthy OPFS copy. */
  isDurable(index: number): boolean {
    return this.diskIndices.has(index)
  }

  get completedCount(): number {
    return this.completedIndices.size
  }

  get completedList(): number[] {
    return Array.from(this.completedIndices).sort((a, b) => a - b)
  }

  /**
   * Assembly has finished integrity verification, so no more sync-handle reads
   * or writes are required. Closing the exclusive handle before getFile()
   * lets Chromium-family engines expose the OPFS file as File slices instead
   * of forcing the fallback that copies every disk chunk into Blob parts.
   */
  prepareBlobReads(): void {
    this.closeSyncHandle()
  }

  /**
   * Re-open the existing exclusive handle after result materialization failed.
   * `prepareBlobReads()` intentionally closes it so File.slice() can back lazy
   * Blobs, but a transient getFile()/entry failure must not make the next
   * assemble attempt treat every still-durable chunk as missing.
   */
  async reopenAfterBlobReadFailure(): Promise<void> {
    if (this.syncHandle || !this.opfsFile || this.preserveReleasedBacking) return
    try {
      if (typeof (this.opfsFile as any).createSyncAccessHandle === "function") {
        this.syncHandle = await (this.opfsFile as any).createSyncAccessHandle()
      }
    } catch {
      this.syncHandle = null
    }
  }

  markResumed(indices: number[]): void {
    for (const i of indices) {
      this.completedIndices.add(i)
      // Resume bits only come from the durable OPFS journal, so their backing
      // data is expected on disk until reverification proves otherwise.
      this.diskIndices.add(i)
    }
  }

  invalidate(index: number): void {
    this.completedIndices.delete(index)
    this.diskIndices.delete(index)
    const previous = this.memory.get(index)
    if (previous) this.memoryBytes -= previous.byteLength
    this.memory.delete(index)
  }

  /**
   * Stop using the backing files without deleting the .partial: delivered
   * Blobs reference it lazily, so the file must outlive the assemble step.
   * A later reset detaches ownership but deliberately leaves this released
   * backing in OPFS; [sweepOrphanPartials] reclaims it after a grace period so
   * an in-flight browser download is not invalidated by a quick rescan.
   */
  async release(): Promise<boolean> {
    this.memory.clear()
    this.memoryBytes = 0
    this.diskIndices.clear()
    this.completedIndices.clear()
    this.closeSyncHandle()
    this.preserveReleasedBacking = this.opfsFile !== null
    if (this.preserveReleasedBacking && this.transferId) {
      releasedBackingAt.set(`af2-${this.transferId}.partial`, Date.now())
      // Persist the delivery moment separately from the partial. Rewriting the
      // partial merely to refresh mtime would invalidate File snapshots that
      // already back UI Blobs; a zero-byte sidecar survives Worker recreation
      // without touching those bytes.
      if (this.opfsDir) {
        let writer: any = null
        try {
          const marker = await this.opfsDir.getFileHandle(
            `af2-${this.transferId}${RELEASE_MARKER_SUFFIX}`,
            { create: true }
          )
          writer = await (marker as any).createWritable({ keepExistingData: false })
          await writer.close()
        } catch {
          try { await writer?.abort?.() } catch {}
          return false
        }
      }
    }
    return true
  }

  async discard(): Promise<void> {
    const preserveBacking = this.preserveReleasedBacking
    this.memory.clear()
    this.memoryBytes = 0
    this.diskIndices.clear()
    this.completedIndices.clear()
    this.closeSyncHandle()
    if (!preserveBacking && this.opfsDir && this.transferId) {
      try {
        await this.opfsDir.removeEntry(`af2-${this.transferId}.partial`)
      } catch {}
      try {
        await this.opfsDir.removeEntry(`af2-${this.transferId}${RELEASE_MARKER_SUFFIX}`)
      } catch {}
    }
    this.opfsFile = null
    this.opfsDir = null
    this.transferId = ""
    this.preserveReleasedBacking = false
  }

  private closeSyncHandle(): void {
    if (!this.syncHandle) return
    try {
      this.syncHandle.close()
    } catch {}
    this.syncHandle = null
  }
}

export class OpfsJournal {
  private opfsDir: FileSystemDirectoryHandle | null = null
  private transferId = ""
  private journalFile: FileSystemFileHandle | null = null

  /** Create a fresh ledger exactly once for a transfer. Repeated init calls
   * append to the already-bound file rather than truncating it. */
  async init(dir: FileSystemDirectoryHandle | null, transferIdHex: string, crs: number, rootHex: string): Promise<void> {
    if (this.transferId === transferIdHex && this.opfsDir === dir && this.journalFile) return

    if (
      !/^[0-9a-f]{32}$/.test(transferIdHex) ||
      !LEGAL_CHUNK_RAW_SIZES.has(crs) ||
      rootHex.length > MAX_ROOT_FRAME_HEX_CHARS ||
      hexToBytes(rootHex).byteLength === 0
    ) {
      throw new Error("AF2_STORAGE_FATAL: 断点日志头字段无效")
    }

    this.opfsDir = dir
    this.transferId = transferIdHex
    this.journalFile = null
    if (!dir || !transferIdHex || !rootHex) return
    let w: any = null
    try {
      const fileName = `af2-${transferIdHex}.ledger.jsonl`
      this.journalFile = await dir.getFileHandle(fileName, { create: true })
      const header = JSON.stringify({ v: 1, tid: transferIdHex, crs, root: rootHex }) + "\n"
      w = await (this.journalFile as any).createWritable({ keepExistingData: false })
      await w.write(header)
      await w.close()
      w = null
    } catch (err) {
      try { await w?.abort?.() } catch {}
      this.journalFile = null
      throw new Error(`AF2_STORAGE_FATAL: 断点日志初始化失败: ${String(err)}`)
    }
  }

  /** Bind to an existing resume ledger without rewriting its header. */
  async openExisting(dir: FileSystemDirectoryHandle | null, transferIdHex: string): Promise<void> {
    if (this.transferId === transferIdHex && this.opfsDir === dir && this.journalFile) return

    this.opfsDir = dir
    this.transferId = transferIdHex
    this.journalFile = null
    if (!dir || !transferIdHex) return
    try {
      this.journalFile = await dir.getFileHandle(`af2-${transferIdHex}.ledger.jsonl`)
    } catch (err) {
      this.journalFile = null
      throw new Error(`AF2_STORAGE_FATAL: 无法打开断点日志: ${String(err)}`)
    }
  }

  async commit(index: number): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0 || index > MAX_CHUNK_INDEX) {
      throw new Error("AF2_STORAGE_FATAL: 断点日志分块索引无效")
    }
    await this.append({ c: index })
  }

  async invalidate(index: number): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0 || index > MAX_CHUNK_INDEX) {
      throw new Error("AF2_STORAGE_FATAL: 断点日志分块索引无效")
    }
    await this.append({ i: index })
  }

  async discard(): Promise<void> {
    if (this.opfsDir && this.transferId) {
      try {
        await this.opfsDir.removeEntry(`af2-${this.transferId}.ledger.jsonl`)
      } catch (err) {
        // A missing file already satisfies discard.  Any other failure keeps
        // ownership intact so reset/retry can attempt deletion again instead
        // of leaving a valid ghost-resume journal behind.
        if (!(err instanceof DOMException && err.name === "NotFoundError")) {
          throw new Error(`AF2_STORAGE_FATAL: 删除断点日志失败: ${String(err)}`)
        }
      }
    }
    this.journalFile = null
    this.opfsDir = null
    this.transferId = ""
  }

  private async append(record: { c: number } | { i: number }): Promise<void> {
    if (!this.journalFile) {
      throw new Error("AF2_STORAGE_FATAL: 断点日志尚未持久化")
    }
    let w: any = null
    try {
      const size = (await this.journalFile.getFile()).size
      const line = JSON.stringify(record) + "\n"
      const lineBytes = new TextEncoder().encode(line).byteLength
      if (size < 0 || size > MAX_LEDGER_BYTES - lineBytes) {
        throw new Error("断点日志超过安全上限")
      }
      w = await (this.journalFile as any).createWritable({ keepExistingData: true })
      await w.seek(size)
      await w.write(line)
      await w.close()
    } catch (err) {
      try { await w?.abort?.() } catch {}
      throw new Error(`AF2_STORAGE_FATAL: 断点日志写入失败: ${String(err)}`)
    }
  }

  static async loadMostRecent(dir: FileSystemDirectoryHandle | null): Promise<{
    transferIdHex: string
    rootFrameBytes: Uint8Array
    chunkRawSize: number
    completed: number[]
  } | null> {
    if (!dir) return null
    try {
      const candidates: Array<{ handle: FileSystemFileHandle; name: string; mtime: number }> = []
      for await (const [name, handle] of (dir as any).entries()) {
        if (typeof name === "string" && LEDGER_NAME_RE.test(name) && handle.kind === "file") {
          // One transiently inaccessible/corrupt candidate must not hide every
          // other resumable transfer in the origin.
          try {
            const file = await handle.getFile()
            candidates.push({ handle, name, mtime: file.lastModified })
          } catch {}
        }
      }
      candidates.sort((a, b) => b.mtime - a.mtime)

      // A torn/corrupt newest ledger must not hide an older valid transfer.
      for (const { handle, name } of candidates) {
        const parsed = await this.parseLedger(handle, name)
        if (parsed) return parsed
      }
      return null
    } catch {
      return null
    }
  }

  private static async parseLedger(handle: FileSystemFileHandle, fileName = handle.name): Promise<{
    transferIdHex: string
    rootFrameBytes: Uint8Array
    chunkRawSize: number
    completed: number[]
  } | null> {
    try {
      const fileTid = LEDGER_NAME_RE.exec(fileName)?.[1]
      if (!fileTid) return null
      const file = await handle.getFile()
      if (file.size > MAX_LEDGER_BYTES) return null
      const text = await file.text()
      const tailTerminated = text.endsWith("\n")
      let durableText = text
      if (!tailTerminated) {
        const lastNewline = text.lastIndexOf("\n")
        if (lastNewline < 0) return null
        durableText = text.slice(0, lastNewline + 1)
      }
      const lines = durableText.split("\n")
      lines.pop()
      // Writers append records as one JSON object plus a final newline. Blank
      // physical records are corruption, not harmless whitespace: filtering
      // them out can hide a damaged invalidation record. Likewise, only an
      // unterminated final fragment may be treated as a crash-torn append.
      if (lines.length === 0 || lines.some((line) => line.trim().length === 0)) return null
      const header = JSON.parse(lines[0])
      if (
        header.v !== 1 ||
        typeof header.tid !== "string" ||
        header.tid !== fileTid ||
        typeof header.root !== "string" ||
        header.root.length > MAX_ROOT_FRAME_HEX_CHARS ||
        !LEGAL_CHUNK_RAW_SIZES.has(header.crs)
      ) return null
      const rootFrameBytes = hexToBytes(header.root)
      if (rootFrameBytes.byteLength === 0) return null

      const completed = new Set<number>()
      for (let i = 1; i < lines.length; i++) {
        try {
          const o = JSON.parse(lines[i])
          const keys = o && typeof o === "object" ? Object.keys(o) : []
          if (
            keys.length === 1 &&
            keys[0] === "c" &&
            Number.isSafeInteger(o.c) &&
            o.c >= 0 &&
            o.c <= MAX_CHUNK_INDEX
          ) {
            completed.add(o.c)
          } else if (
            keys.length === 1 &&
            keys[0] === "i" &&
            Number.isSafeInteger(o.i) &&
            o.i >= 0 &&
            o.i <= MAX_CHUNK_INDEX
          ) {
            completed.delete(o.i)
          } else {
            return null
          }
        } catch {
          return null
        }
      }
      if (!tailTerminated) {
        // The newline is the record's commit delimiter. Truncate any crash
        // fragment before returning a resumable journal; otherwise the next
        // append would concatenate onto it and create permanent corruption.
        let writer: any = null
        try {
          if ((await handle.getFile()).size !== file.size) return null
          const durableByteLength = new TextEncoder().encode(durableText).byteLength
          writer = await (handle as any).createWritable({ keepExistingData: true })
          await writer.truncate(durableByteLength)
          await writer.close()
        } catch {
          try { await writer?.abort?.() } catch {}
          return null
        }
      }
      return {
        transferIdHex: header.tid,
        rootFrameBytes,
        chunkRawSize: header.crs,
        completed: Array.from(completed).sort((a, b) => a - b),
      }
    } catch {
      return null
    }
  }

  static async isValidLedger(handle: FileSystemFileHandle): Promise<boolean> {
    return (await this.parseLedger(handle)) !== null
  }
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return new Uint8Array(0)
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Delete .partial spill files that no longer have a matching resume ledger.
 *
 * A completed transfer releases its .partial (delivered Blobs may reference it
 * lazily) and discards its ledger. Ledger-less partials carry no resume state,
 * but a freshly released one can still be feeding a browser download, so they
 * are removed only after [orphanGraceMs]. A partial paired with a corrupt
 * ledger is unrecoverable and is removed immediately. Partials owned by
 * another live worker (holding an exclusive sync handle) fail removeEntry and
 * are left alone.
 */
export async function sweepOrphanPartials(
  dir: FileSystemDirectoryHandle | null,
  orphanGraceMs = 60 * 60 * 1000,
  retainedBytesCap = 2 * 1024 * 1024 * 1024,
): Promise<void> {
  if (!dir) return
  try {
    const ledgers = new Set<string>()
    const invalidLedgers: string[] = []
    const invalidLedgerTids = new Set<string>()
    const releaseMarkers = new Map<string, { name: string; mtime: number | null }>()
    const partials: Array<{
      name: string
      mtime: number
      size: number
      releasedAt?: number
    }> = []
    for await (const [name, handle] of (dir as any).entries()) {
      if (typeof name !== "string" || handle.kind !== "file") continue
      const ledgerMatch = LEDGER_NAME_RE.exec(name)
      const markerMatch = RELEASE_MARKER_NAME_RE.exec(name)
      const partialMatch = PARTIAL_NAME_RE.exec(name)
      if (ledgerMatch) {
        if (await OpfsJournal.isValidLedger(handle)) {
          ledgers.add(name)
        } else {
          invalidLedgers.push(name)
          invalidLedgerTids.add(ledgerMatch[1])
        }
      }
      else if (markerMatch) {
        let mtime: number | null = null
        try {
          const value = (await handle.getFile()).lastModified
          if (Number.isFinite(value) && value > 0) mtime = value
        } catch {}
        const partialName = `af2-${markerMatch[1]}.partial`
        releaseMarkers.set(partialName, { name, mtime })
      }
      else if (partialMatch) {
        let mtime = 0
        let size = 0
        try {
          const file = await handle.getFile()
          mtime = file.lastModified || 0
          size = file.size || 0
        } catch {}
        partials.push({ name, mtime, size, releasedAt: releasedBackingAt.get(name) })
      }
    }
    // Mutate the directory only after enumeration completes; browser OPFS
    // implementations need not define iterator behaviour under deletion.
    for (const invalid of invalidLedgers) {
      try { await dir.removeEntry(invalid) } catch {}
    }
    const now = Date.now()
    const partialNames = new Set(partials.map(({ name }) => name))
    const retained: Array<{ name: string; size: number; graceStartedAt: number }> = []
    for (const { name: partial, mtime, size, releasedAt } of partials) {
      if (ledgers.has(partial.replace(/\.partial$/, ".ledger.jsonl"))) continue
      const tid = PARTIAL_NAME_RE.exec(partial)?.[1] ?? ""
      // A corrupt journal can never resume, so its backing spill is garbage
      // immediately. A ledger-less partial may instead back a just-delivered
      // lazy Blob; give browser downloads time to finish before unlinking it.
      // Prefer the durable sidecar timestamp: the module-level timestamp is
      // lost whenever ReceivePage replaces its Worker, and the partial mtime
      // may be hours old for a resumed transfer that needed no final write.
      const marker = releaseMarkers.get(partial)
      // Marker existence proves this is a delivered backing. If its metadata
      // is transiently unreadable, fail closed and start a fresh grace window;
      // falling back to an hours-old chunk mtime could unlink an active Blob.
      const graceStartedAt = marker
        ? (marker.mtime ?? now)
        : (releasedAt ?? mtime)
      if (!invalidLedgerTids.has(tid) && orphanGraceMs > 0 && now - graceStartedAt < orphanGraceMs) {
        retained.push({ name: partial, size, graceStartedAt })
        continue
      }
      try {
        await dir.removeEntry(partial)
        releasedBackingAt.delete(partial)
        partialNames.delete(partial)
      } catch {}
    }
    // The grace period is per-file, so back-to-back multi-gigabyte receives
    // would hold every delivered backing for the full hour and can exhaust the
    // OPFS quota — failing the next transfer. Bound the retained set, evicting
    // oldest first so the most recent download keeps its grace.
    let retainedBytes = retained.reduce((sum, entry) => sum + entry.size, 0)
    if (retainedBytes > retainedBytesCap) {
      retained.sort((a, b) => a.graceStartedAt - b.graceStartedAt)
      // Never evict the newest backing solely because that one legal receive
      // is larger than the cap (the web host allows up to 8 GiB while the
      // default retained-set cap is 2 GiB). It may be feeding the download we
      // just handed to the user. Reclaim every older grace entry first and
      // tolerate one oversize newest entry until its normal grace expires.
      for (let i = 0; i + 1 < retained.length; i++) {
        if (retainedBytes <= retainedBytesCap) break
        const entry = retained[i]
        try {
          await dir.removeEntry(entry.name)
          releasedBackingAt.delete(entry.name)
          partialNames.delete(entry.name)
          retainedBytes -= entry.size
        } catch {}
      }
    }
    // Markers are meaningful only while their matching lazy-Blob backing
    // exists. Remove sidecars after (and only after) the partial disappeared;
    // if unlinking a live/locked partial failed, its protection must remain.
    for (const [partialName, marker] of releaseMarkers) {
      if (partialNames.has(partialName)) continue
      try {
        await dir.removeEntry(marker.name)
        releasedBackingAt.delete(partialName)
      } catch {}
    }
  } catch {}
}
