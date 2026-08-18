import assert from "node:assert/strict"
import test from "node:test"

import { ChunkStore, OpfsJournal, sweepOrphanPartials } from "../src/workers/receive-storage.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

class FakeFileHandle {
  constructor(name) {
    this.kind = "file"
    this.name = name
    this.bytes = new Uint8Array(0)
    this.lastModified = Date.now()
    this.syncOpen = false
    this.syncOpenCount = 0
    this.failWriteAt = null
    this.shortWriteAt = null
    /** Simulates a stale/short getFile() snapshot (size guard must trip). */
    this.getFileSize = null
    this.getFileFailsWhileSyncOpen = false
  }

  async getFile() {
    if (this.getFileFailsWhileSyncOpen && this.syncOpen) {
      throw new Error("getFile unavailable while sync handle is open")
    }
    const snapshot = this.bytes.slice()
    const size = this.getFileSize ?? snapshot.byteLength
    return {
      size,
      lastModified: this.lastModified,
      text: async () => decoder.decode(snapshot),
      slice: (start, end) =>
        new Blob([snapshot.subarray(Math.max(0, start), Math.min(snapshot.byteLength, end))]),
    }
  }

  async createSyncAccessHandle() {
    this.syncOpenCount++
    if (this.syncOpen) throw new Error("SyncAccessHandle already locked")
    this.syncOpen = true
    const file = this
    return {
      read(buf, options = {}) {
        const at = options.at ?? 0
        const target = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        const available = Math.max(0, Math.min(target.byteLength, file.bytes.byteLength - at))
        if (available > 0) target.set(file.bytes.subarray(at, at + available))
        return available
      },
      write(buf, options = {}) {
        const at = options.at ?? 0
        if (file.failWriteAt === at) throw new Error("simulated write failure")
        const source = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        const requested = source.byteLength
        const actual = file.shortWriteAt === at ? Math.max(0, requested - 1) : requested
        const required = at + actual
        if (required > file.bytes.byteLength) {
          const grown = new Uint8Array(required)
          grown.set(file.bytes)
          file.bytes = grown
        }
        file.bytes.set(source.subarray(0, actual), at)
        file.lastModified++
        return actual
      },
      flush() {},
      close() {
        file.syncOpen = false
      },
      getSize() {
        return file.bytes.byteLength
      },
    }
  }

  async createWritable({ keepExistingData = false } = {}) {
    let working = keepExistingData ? this.bytes.slice() : new Uint8Array(0)
    let position = 0
    const file = this
    return {
      async seek(next) {
        position = next
      },
      async write(value) {
        const source = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value)
        const required = position + source.byteLength
        if (required > working.byteLength) {
          const grown = new Uint8Array(required)
          grown.set(working)
          working = grown
        }
        working.set(source, position)
        position += source.byteLength
      },
      async close() {
        file.bytes = working
        file.lastModified++
      },
    }
  }
}

class FakeDirectoryHandle {
  constructor() {
    this.files = new Map()
  }

  async getFileHandle(name, options = {}) {
    const existing = this.files.get(name)
    if (existing) return existing
    if (!options.create) throw new Error("not found")
    const file = new FakeFileHandle(name)
    this.files.set(name, file)
    return file
  }

  async removeEntry(name) {
    if (!this.files.delete(name)) throw new Error("not found")
  }

  async *entries() {
    yield* this.files.entries()
  }
}

test("ChunkStore acquires one exclusive OPFS handle per transfer", async () => {
  const dir = new FakeDirectoryHandle()
  const store = new ChunkStore()

  await store.init(dir, "abcd")
  assert.equal(store.writeChunk(0, 4, Uint8Array.from([1, 2, 3, 4])), "disk")
  await store.init(dir, "abcd")
  assert.equal(store.writeChunk(1, 4, Uint8Array.from([5, 6, 7, 8])), "disk")

  const partial = dir.files.get("af2-abcd.partial")
  assert.equal(partial.syncOpenCount, 1)
  assert.deepEqual(Array.from(store.readRange(0, 8, 8, 4)), [1, 2, 3, 4, 5, 6, 7, 8])
})

test("ChunkStore reads a mixed disk + memory fallback transfer", async () => {
  const dir = new FakeDirectoryHandle()
  const store = new ChunkStore()
  await store.init(dir, "mixed")
  const partial = dir.files.get("af2-mixed.partial")

  assert.equal(store.writeChunk(0, 4, Uint8Array.from([1, 2, 3, 4])), "disk")
  partial.failWriteAt = 4
  assert.equal(store.writeChunk(1, 4, Uint8Array.from([5, 6, 7, 8])), "memory")
  assert.deepEqual(Array.from(store.readRange(0, 8, 8, 4)), [1, 2, 3, 4, 5, 6, 7, 8])
})

test("ChunkStore treats a short OPFS write as non-durable", async () => {
  const dir = new FakeDirectoryHandle()
  const store = new ChunkStore()
  await store.init(dir, "short")
  const partial = dir.files.get("af2-short.partial")
  partial.shortWriteAt = 0

  assert.equal(store.writeChunk(0, 4, Uint8Array.from([9, 8, 7, 6])), "memory")
  assert.deepEqual(Array.from(store.readRange(0, 4, 4, 4)), [9, 8, 7, 6])
})

test("ChunkStore resume does not create a missing partial file", async () => {
  const dir = new FakeDirectoryHandle()
  const store = new ChunkStore()
  await store.init(dir, "missing", { create: false })
  store.markResumed([0])

  assert.equal(dir.files.has("af2-missing.partial"), false)
  assert.equal(store.readChunk(0, 4, 4), null)
})

test("readRangeBlob assembles disk spans and memory fallback spans", async () => {
  const dir = new FakeDirectoryHandle()
  const store = new ChunkStore()
  await store.init(dir, "blobmix")
  const partial = dir.files.get("af2-blobmix.partial")

  assert.equal(store.writeChunk(0, 4, Uint8Array.from([1, 2, 3, 4])), "disk")
  partial.failWriteAt = 4
  assert.equal(store.writeChunk(1, 4, Uint8Array.from([5, 6, 7, 8])), "memory")

  const blob = await store.readRangeBlob(0, 8, 8, 4)
  assert.equal(blob.size, 8)
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [1, 2, 3, 4, 5, 6, 7, 8])

  // Sub-range that starts inside the memory chunk.
  const tail = await store.readRangeBlob(5, 3, 8, 4)
  assert.deepEqual(Array.from(new Uint8Array(await tail.arrayBuffer())), [6, 7, 8])

  // Out-of-bounds requests reject instead of returning a short blob; an
  // empty range yields an empty blob.
  assert.equal(await store.readRangeBlob(4, 5, 8, 4), null)
  assert.equal((await store.readRangeBlob(0, 0, 8, 4)).size, 0)
})

test("readRangeBlob ignores a stale getFile snapshot and reads via the sync handle", async () => {
  const dir = new FakeDirectoryHandle()
  const store = new ChunkStore()
  await store.init(dir, "stale")
  const partial = dir.files.get("af2-stale.partial")
  assert.equal(store.writeChunk(0, 4, Uint8Array.from([9, 9, 9, 9])), "disk")

  // getFile() reports a shorter file than the range needs: the size guard
  // must refuse the lazy-slice path and fall back to syncHandle reads.
  partial.getFileSize = 2
  const blob = await store.readRangeBlob(0, 4, 4, 4)
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [9, 9, 9, 9])
})

test("prepareBlobReads closes exclusive sync handle before lazy File slicing", async () => {
  const dir = new FakeDirectoryHandle()
  const store = new ChunkStore()
  await store.init(dir, "blob-close")
  const partial = dir.files.get("af2-blob-close.partial")
  partial.getFileFailsWhileSyncOpen = true
  assert.equal(store.writeChunk(0, 4, Uint8Array.from([4, 3, 2, 1])), "disk")

  store.prepareBlobReads()
  assert.equal(partial.syncOpen, false)
  const blob = await store.readRangeBlob(0, 4, 4, 4)
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [4, 3, 2, 1])
})

test("readRangeBlob refuses multi-chunk sync fallback instead of allocating O(entry)", async () => {
  const dir = new FakeDirectoryHandle()
  const store = new ChunkStore()
  await store.init(dir, "bounded-fallback")
  const partial = dir.files.get("af2-bounded-fallback.partial")
  partial.getFileFailsWhileSyncOpen = true
  assert.equal(store.writeChunk(0, 4, Uint8Array.from([1, 2, 3, 4])), "disk")
  assert.equal(store.writeChunk(1, 4, Uint8Array.from([5, 6, 7, 8])), "disk")

  // While the exclusive handle is open there is no lazy File view. A large
  // request must fail boundedly rather than retain one copy per chunk.
  assert.equal(await store.readRangeBlob(0, 8, 8, 4), null)

  // The real assembly path closes the handle first; the same range then uses
  // lazy File slices and succeeds without whole-entry copies.
  store.prepareBlobReads()
  const blob = await store.readRangeBlob(0, 8, 8, 4)
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [1, 2, 3, 4, 5, 6, 7, 8])
})

test("release + discard keep a delivered lazy Blob backing until orphan sweep grace expires", async () => {
  const dir = new FakeDirectoryHandle()
  const store = new ChunkStore()
  await store.init(dir, "keepalive")
  assert.equal(store.writeChunk(0, 4, Uint8Array.from([1, 2, 3, 4])), "disk")

  const blob = await store.readRangeBlob(0, 4, 4, 4)
  store.release()

  // The delivered Blob is a lazy OPFS reference — the file must survive the
  // assemble step so the user's later download still reads valid bytes.
  assert.ok(dir.files.has("af2-keepalive.partial"))
  assert.equal(blob.size, 4)
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), [1, 2, 3, 4])

  // Session reset must not unlink a backing file that a browser download may
  // still be consuming lazily.
  await store.discard()
  assert.equal(dir.files.has("af2-keepalive.partial"), true)
  await sweepOrphanPartials(dir, 0)
  assert.equal(dir.files.has("af2-keepalive.partial"), false)
})

test("sweepOrphanPartials removes ledger-less partials and keeps journaled ones", async () => {
  const dir = new FakeDirectoryHandle()
  // A journaled (in-progress-or-resumable) transfer: partial + ledger.
  const journaled = new OpfsJournal()
  await journaled.init(dir, "hasledger", 4, "0102")
  const live = new ChunkStore()
  await live.init(dir, "hasledger")
  assert.equal(live.writeChunk(0, 4, Uint8Array.from([2, 2, 2, 2])), "disk")
  // An orphan partial: released after a delivered transfer (ledger discarded).
  const owned = new ChunkStore()
  await owned.init(dir, "orphan")
  assert.equal(owned.writeChunk(0, 4, Uint8Array.from([1, 1, 1, 1])), "disk")

  await sweepOrphanPartials(dir, 0)

  assert.ok(dir.files.has("af2-hasledger.partial"))
  assert.ok(dir.files.has("af2-hasledger.ledger.jsonl"))
  assert.equal(dir.files.has("af2-orphan.partial"), false)
})

test("sweepOrphanPartials removes partials whose matching ledger is corrupt", async () => {
  const dir = new FakeDirectoryHandle()
  const badLedger = await dir.getFileHandle("af2-bad.ledger.jsonl", { create: true })
  const writer = await badLedger.createWritable()
  await writer.write("not-json\n")
  await writer.close()
  const partial = await dir.getFileHandle("af2-bad.partial", { create: true })
  const sync = await partial.createSyncAccessHandle()
  sync.write(Uint8Array.from([1, 2, 3, 4]), { at: 0 })
  sync.close()

  await sweepOrphanPartials(dir, 0)

  assert.equal(dir.files.has("af2-bad.ledger.jsonl"), false)
  assert.equal(dir.files.has("af2-bad.partial"), false)
})

test("sweepOrphanPartials preserves a fresh delivered partial during the grace period", async () => {
  const dir = new FakeDirectoryHandle()
  const orphan = await dir.getFileHandle("af2-fresh.partial", { create: true })
  const sync = await orphan.createSyncAccessHandle()
  sync.write(Uint8Array.from([7, 7, 7, 7]), { at: 0 })
  sync.close()
  orphan.lastModified = Date.now()

  await sweepOrphanPartials(dir, 60_000)
  assert.equal(dir.files.has("af2-fresh.partial"), true)

  orphan.lastModified = Date.now() - 120_000
  await sweepOrphanPartials(dir, 60_000)
  assert.equal(dir.files.has("af2-fresh.partial"), false)
})

test("OpfsJournal loadMostRecent skips a corrupt newer journal", async () => {
  const dir = new FakeDirectoryHandle()
  const valid = new OpfsJournal()
  await valid.init(dir, "older", 4, "01020304")
  await valid.commit(2)
  dir.files.get("af2-older.ledger.jsonl").lastModified = 100

  const bad = await dir.getFileHandle("af2-newer.ledger.jsonl", { create: true })
  const w = await bad.createWritable()
  await w.write("bad")
  await w.close()
  bad.lastModified = 200

  const loaded = await OpfsJournal.loadMostRecent(dir)
  assert.equal(loaded.transferIdHex, "older")
  assert.deepEqual(loaded.completed, [2])
})

test("OpfsJournal init is idempotent and keeps all committed chunk bits", async () => {
  const dir = new FakeDirectoryHandle()
  const journal = new OpfsJournal()

  await journal.init(dir, "cafe", 4, "01020304")
  await journal.commit(0)
  await journal.init(dir, "cafe", 4, "01020304")
  await journal.commit(1)

  const loaded = await OpfsJournal.loadMostRecent(dir)
  assert.equal(loaded.transferIdHex, "cafe")
  assert.deepEqual(loaded.completed, [0, 1])
  assert.deepEqual(Array.from(loaded.rootFrameBytes), [1, 2, 3, 4])
})

test("OpfsJournal openExisting preserves root and prior commits across a second crash", async () => {
  const dir = new FakeDirectoryHandle()
  const first = new OpfsJournal()
  await first.init(dir, "beef", 4, "aabbccdd")
  await first.commit(0)

  const resumed = new OpfsJournal()
  await resumed.openExisting(dir, "beef")
  await resumed.commit(1)

  const loaded = await OpfsJournal.loadMostRecent(dir)
  assert.equal(loaded.transferIdHex, "beef")
  assert.deepEqual(loaded.completed, [0, 1])
  assert.deepEqual(Array.from(loaded.rootFrameBytes), [0xaa, 0xbb, 0xcc, 0xdd])
})
