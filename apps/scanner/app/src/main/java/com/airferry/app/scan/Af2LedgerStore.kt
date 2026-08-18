package com.airferry.app.scan

import java.io.File
import java.io.FileOutputStream
import org.json.JSONObject

/**
 * Crash-safe §12 resume ledger — the journal twin of [ChunkSpillStore]'s
 * `.partial` file.
 *
 * Format: one JSONL journal per transfer, `af2-<tid>.ledger.jsonl`.
 * - Line 1 (header): `{"v":1,"tid":…,"root":…,"crs":…}` — written once,
 *   atomically (temp file + fsync + rename) before the first chunk commit.
 * - Each later line: `{"c":<index>}` (chunk committed after spill+fsync) or
 *   `{"i":<index>}` (chunk invalidated after a re-verification failure).
 *
 * Per-line append + fsync keeps every interleaving crash-safe: a torn tail
 * line fails `JSONObject` parsing and is skipped, so the ledger never
 * reports MORE than what hit the disk. A commit line is only appended after
 * the chunk bytes were pwrite + fsync'd into the spill — the §12 ordering
 * rule "账本完成 ⇒ 数据已落盘" holds by construction.
 *
 * Only touched from the ingest thread (the decode pool serializes ingest)
 * and the recovery path that runs under the same lock.
 */
class Af2LedgerStore private constructor(private val path: File) {

    var transferIdHex: String = ""
        private set
    var chunkRawSize: Int = 0
        private set
    /** ROOT frame bytes (hex at rest) for the §12 resume() call. */
    var rootFrameBytes: ByteArray = ByteArray(0)
        private set
    private val completed = sortedSetOf<Int>()

    val completedIndices: IntArray get() = completed.toIntArray()

    /** Load an existing ledger for `tid`, or null when none exists. */
    fun reload(): Boolean {
        completed.clear()
        if (!path.isFile) return false
        val lines = try {
            path.readLines()
        } catch (_: Exception) {
            return false
        }
        var header: JSONObject? = null
        for (line in lines) {
            if (line.isBlank()) continue
            val o = try {
                JSONObject(line)
            } catch (_: Exception) {
                continue // torn tail line from a mid-write crash
            }
            if (header == null && o.has("v")) {
                header = o
                continue
            }
            if (o.has("c")) completed.add(o.getInt("c"))
            if (o.has("i")) completed.remove(o.getInt("i"))
        }
        val h = header ?: return false
        transferIdHex = h.optString("tid", "")
        chunkRawSize = h.optInt("crs", 0)
        rootFrameBytes = hexToBytes(h.optString("root", ""))
        return transferIdHex.isNotEmpty() && rootFrameBytes.isNotEmpty()
    }

    /** Append one commit event (after the chunk was spilled + fsync'd). */
    fun commit(index: Int) {
        appendLine(JSONObject().put("c", index))
        completed.add(index)
    }

    /** Append one invalidate event (after a spill re-verification failure). */
    fun invalidate(index: Int) {
        appendLine(JSONObject().put("i", index))
        completed.remove(index)
    }

    private fun appendLine(o: JSONObject) {
        try {
            FileOutputStream(path, true).use { fos ->
                fos.write((o.toString() + "\n").toByteArray())
                fos.fd.sync()
            }
        } catch (e: Exception) {
            android.util.Log.w("Af2LedgerStore", "append failed", e)
        }
    }

    /** Delete the journal (transfer finished / relocked away / abandoned). */
    fun discard() {
        path.delete()
    }

    data class PendingTransfer(
        val transferIdHex: String,
        val chunkRawSize: Int,
        val completedCount: Int,
        val diskBytes: Long,
        val lastModified: Long,
    )

    companion object {
        /** List all uncompleted/partial transfer ledgers in `dir`. */
        fun listPendingTransfers(dir: File): List<PendingTransfer> {
            val candidates = dir.listFiles { f -> f.name.startsWith("af2-") && f.name.endsWith(".ledger.jsonl") }
                ?: return emptyList()
            val list = mutableListOf<PendingTransfer>()
            for (f in candidates) {
                val store = Af2LedgerStore(f)
                if (store.reload()) {
                    val tid = store.transferIdHex
                    val spill = File(dir, "af2-$tid.partial")
                    val spillBytes = if (spill.isFile) spill.length() else 0L
                    list.add(
                        PendingTransfer(
                            transferIdHex = tid,
                            chunkRawSize = store.chunkRawSize,
                            completedCount = store.completedIndices.size,
                            diskBytes = f.length() + spillBytes,
                            lastModified = f.lastModified()
                        )
                    )
                }
            }
            return list.sortedByDescending { it.lastModified }
        }

        /** Discard all pending journals and spill files in `dir`. */
        fun discardAllPending(dir: File) {
            dir.listFiles { f ->
                f.name.startsWith("af2-") && (
                    f.name.endsWith(".ledger.jsonl") ||
                    f.name.endsWith(".partial") ||
                    f.name.endsWith(".tmp")
                )
            }?.forEach { it.delete() }
        }

        /** Resume source: newest valid ledger in `dir` (by mtime), or null. */
        fun loadMostRecent(dir: File): Af2LedgerStore? {
            val candidates = dir.listFiles { f -> f.name.endsWith(".ledger.jsonl") }
                ?: return null
            for (candidate in candidates.sortedByDescending { it.lastModified() }) {
                val store = Af2LedgerStore(candidate)
                if (store.reload()) return store
            }
            return null
        }

        /** Remove unrecoverable spill files that have no valid resume journal. */
        fun sweepOrphanPartials(dir: File) {
            val validTids = mutableSetOf<String>()
            dir.listFiles { f -> f.name.endsWith(".ledger.jsonl") }?.forEach { file ->
                val store = Af2LedgerStore(file)
                if (store.reload()) {
                    validTids.add(store.transferIdHex)
                } else {
                    file.delete()
                }
            }
            dir.listFiles { f -> f.name.startsWith("af2-") && f.name.endsWith(".partial") }
                ?.forEach { partial ->
                    val tid = partial.name.removePrefix("af2-").removeSuffix(".partial")
                    if (tid !in validTids) partial.delete()
                }
        }

        /** Create + write the header for a fresh transfer's journal. */
        fun create(
            dir: File,
            transferIdHex: String,
            chunkRawSize: Int,
            rootFrameBytes: ByteArray
        ): Af2LedgerStore {
            val path = File(dir, "af2-${transferIdHex.ifEmpty { "session" }}.ledger.jsonl")
            path.delete() // a relock restarts the journal from scratch
            val header = JSONObject()
                .put("v", 1)
                .put("tid", transferIdHex)
                .put("crs", chunkRawSize)
                .put("root", bytesToHex(rootFrameBytes))
            // Atomic header: temp + fsync + rename so a crash mid-create
            // never leaves a headerless journal that a later commit would
            // append to.
            val tmp = File(dir, path.name + ".tmp")
            try {
                FileOutputStream(tmp).use { fos ->
                    fos.write((header.toString() + "\n").toByteArray())
                    fos.fd.sync()
                }
                if (!tmp.renameTo(path)) {
                    // Cross-filesystem rename fallback (cache dirs are same-FS
                    // in practice; copy keeps the fsync-before-rename order).
                    tmp.copyTo(path, overwrite = true)
                    path.setLastModified(System.currentTimeMillis())
                    tmp.delete()
                }
            } catch (e: Exception) {
                android.util.Log.w("Af2LedgerStore", "header write failed", e)
                tmp.delete()
            }
            return Af2LedgerStore(path).apply {
                this.transferIdHex = transferIdHex
                this.chunkRawSize = chunkRawSize
                this.rootFrameBytes = rootFrameBytes
            }
        }

        /** Drop the journal (and spill) of `tid` — completion cleanup. */
        fun discardFor(dir: File, transferIdHex: String) {
            File(dir, "af2-$transferIdHex.ledger.jsonl").delete()
        }

        private fun bytesToHex(b: ByteArray): String =
            b.joinToString("") { "%02x".format(it) }

        private fun hexToBytes(s: String): ByteArray {
            if (s.length % 2 != 0) return ByteArray(0)
            return ByteArray(s.length / 2) { i ->
                ((Character.digit(s[i * 2], 16) shl 4) +
                    Character.digit(s[i * 2 + 1], 16)).toByte()
            }
        }
    }
}
