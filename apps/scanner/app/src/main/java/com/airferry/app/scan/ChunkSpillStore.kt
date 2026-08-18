package com.airferry.app.scan

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * Sparse on-disk staging for completed AF2 chunks — the receiver-side half of
 * the bounded-memory ledger (plan E2).
 *
 * Completed chunks are RAW (post-decode, post-decompress) and fixed-size
 * except the last, so the spill file's layout IS the canonical content
 * stream: chunk `i` lives at byte offset `i * chunkRawSize`. Manifest entries
 * are then sliced straight from the file by offset/size — the full stream
 * never has to exist in memory, and native chunks are evicted as soon as
 * they are spilled ([ReceiverSessionManager.drainLastChunk]).
 *
 * Only ever touched from the ingest thread (the decode pool serializes
 * ingest) and the recovery path that runs under the same lock, so a single
 * [RandomAccessFile] needs no extra synchronization.
 */
class ChunkSpillStore(dir: File, transferIdHex: String) {

    private val path = File(dir, "af2-${transferIdHex.ifEmpty { "session" }}.partial")
    private var raf: RandomAccessFile? = null
    /** Sparse-file length cannot prove which ranges are real (holes read as
     * zeroes), so track chunks known durable this session / from §12 resume. */
    private val knownChunks = mutableSetOf<Int>()

    /** pwrite one completed chunk at its canonical-stream offset + fsync. */
    fun write(index: Int, chunkRawSize: Int, bytes: ByteArray) {
        require(index >= 0 && chunkRawSize > 0 && bytes.isNotEmpty()) {
            "invalid spill chunk"
        }
        val f = raf ?: RandomAccessFile(path, "rw").also { raf = it }
        f.seek(index.toLong() * chunkRawSize.toLong())
        f.write(bytes)
        // §12 durability invariant: the caller may journal + forget the native
        // chunk only after this returns. Never swallow sync failures here.
        f.fd.sync()
        knownChunks.add(index)
    }

    fun hasChunk(index: Int): Boolean = index in knownChunks

    fun markResumed(indices: IntArray) {
        for (index in indices) knownChunks.add(index)
    }

    /** Current spill size in bytes (0 when nothing was spilled yet). */
    fun length(): Long = raf?.length() ?: if (path.isFile) path.length() else 0L

    /**
     * Read a canonical-stream range. Returns null when the spill is shorter
     * than the requested range end (incomplete spill) — callers then fall
     * back to the in-memory assemble path.
     */
    fun readRange(offset: Long, size: Long): ByteArray? {
        if (offset < 0 || size < 0 || size > Int.MAX_VALUE) return null
        if (!path.isFile && raf == null) return null
        // Open read-write even for reads: the cached handle is shared with
        // [write], and a read-only handle cached first would poison every
        // later chunk spill after a resume re-verify.
        val f = raf ?: try {
            RandomAccessFile(path, "rw").also { raf = it }
        } catch (_: Exception) {
            return null
        }
        if (offset + size > f.length()) return null
        val out = ByteArray(size.toInt())
        f.seek(offset)
        var done = 0
        while (done < out.size) {
            val n = f.read(out, done, out.size - done)
            if (n < 0) return null
            done += n
        }
        return out
    }

    /**
     * Copy one canonical-stream range to a file with bounded memory. The
     * destination is replaced atomically from the caller's perspective only
     * after this method returns true; on failure the partial destination is
     * removed.
     */
    fun copyRangeToFile(
        offset: Long,
        size: Long,
        destination: File,
        bufferSize: Int = 1024 * 1024,
    ): Boolean {
        if (offset < 0 || size < 0 || bufferSize <= 0) return false
        if (!path.isFile && raf == null) return false
        // Same read-write rationale as [readRange]: the cached handle must
        // stay writable for subsequent chunk spills.
        val f = raf ?: try {
            RandomAccessFile(path, "rw").also { raf = it }
        } catch (_: Exception) {
            return false
        }
        if (offset > f.length() || size > f.length() - offset) return false
        destination.parentFile?.mkdirs()
        return try {
            f.seek(offset)
            FileOutputStream(destination, false).use { out ->
                val buffer = ByteArray(
                    minOf(bufferSize.toLong(), size.coerceAtLeast(1L)).toInt()
                )
                var remaining = size
                while (remaining > 0) {
                    val want = minOf(buffer.size.toLong(), remaining).toInt()
                    val n = f.read(buffer, 0, want)
                    if (n <= 0) throw java.io.EOFException("spill range truncated")
                    out.write(buffer, 0, n)
                    remaining -= n.toLong()
                }
                out.fd.sync()
            }
            destination.isFile && destination.length() == size
        } catch (e: Exception) {
            android.util.Log.w("ChunkSpillStore", "copyRangeToFile failed", e)
            destination.delete()
            false
        }
    }

    /** Close and delete the spill (transfer relocked / consumed / abandoned). */
    fun discard() {
        try {
            raf?.close()
        } catch (_: Exception) {
        }
        raf = null
        knownChunks.clear()
        path.delete()
    }
}
