package com.airferry.app.scan

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

/**
 * Content-addressed store + logical entry index (no OS symlinks).
 *
 * Layout under [root]:
 *   blobs/&lt;hh&gt;/&lt;sha256&gt;   — file bytes (one copy per unique content)
 *   index.json              — array of logical entries (name, hash, meta…)
 *
 * Multiple entries may share one blob ([refCount] via counting hash references).
 * History list / detail / share all resolve to the blob path — no recovered_*
 * double-write and no share/ staging copy required.
 */
object ContentStore {

    private const val TAG = "ContentStore"
    private const val DIR_NAME = "store"
    private const val BLOBS = "blobs"
    private const val INDEX = "index.json"

    data class Entry(
        val id: String,
        val name: String,
        val hash: String,
        val size: Long,
        val crcHex: String,       // "unknown" or hex
        val crcUnknown: Boolean,
        val kind: String,         // "file" | "text"
        val createdAt: Long,
        val bundleId: String?,    // null = top-level file
        val bundleTitle: String?, // display name for bundle group
    ) {
        fun blobFile(ctx: Context): File = blobPath(ctx, hash)
    }

    data class PutResult(
        val entry: Entry,
        val path: File,
        val deduped: Boolean,
    )

    data class PutBytesRequest(
        val displayName: String,
        val bytes: ByteArray,
        val crcHex: String = "unknown",
        val crcUnknown: Boolean = true,
        val kind: String = "file",
        val bundleId: String? = null,
        val bundleTitle: String? = null,
    )

    data class PutFileRequest(
        val displayName: String,
        val file: File,
        val crcHex: String = "unknown",
        val crcUnknown: Boolean = true,
        val kind: String = "file",
        val bundleId: String? = null,
        val bundleTitle: String? = null,
        val expectedSize: Long? = null,
    )

    fun root(ctx: Context): File {
        val base = ctx.getExternalFilesDir(null) ?: ctx.filesDir
        return File(base, DIR_NAME).also { if (!it.exists()) it.mkdirs() }
    }

    fun blobPath(ctx: Context, hash: String): File {
        val h = hash.lowercase()
        require(h.length == 64 && h.all { it in '0'..'9' || it in 'a'..'f' }) {
            "invalid SHA-256 hash"
        }
        val dir = File(root(ctx), "$BLOBS/${h.take(2)}")
        if (!dir.exists()) dir.mkdirs()
        return File(dir, h)
    }

    /** SHA-256 hex of [bytes]. */
    fun sha256Hex(bytes: ByteArray): String {
        val d = MessageDigest.getInstance("SHA-256").digest(bytes)
        return d.joinToString("") { b -> "%02x".format(b) }
    }

    fun sha256Hex(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { ins ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = ins.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { b -> "%02x".format(b) }
    }

    @Synchronized
    fun putBytes(
        ctx: Context,
        displayName: String,
        bytes: ByteArray,
        crcHex: String = "unknown",
        crcUnknown: Boolean = true,
        kind: String = "file",
        bundleId: String? = null,
        bundleTitle: String? = null,
    ): PutResult {
        return putBytesBatch(
            ctx,
            listOf(
                PutBytesRequest(
                    displayName, bytes, crcHex, crcUnknown, kind, bundleId, bundleTitle,
                )
            ),
        ).single()
    }

    /** Archive a bundle with one index read/write instead of O(n²) rewrites. */
    @Synchronized
    fun putBytesBatch(ctx: Context, requests: List<PutBytesRequest>): List<PutResult> {
        if (requests.isEmpty()) return emptyList()
        // Read and validate the index before touching blob storage. A corrupt
        // index must never be interpreted as an empty history and overwritten.
        val all = loadIndex(ctx).toMutableList()
        val results = ArrayList<PutResult>(requests.size)
        val createdAt = System.currentTimeMillis()
        for (request in requests) {
            val hash = sha256Hex(request.bytes)
            val blob = blobPath(ctx, hash)
            val deduped = blob.exists() && blob.length() == request.bytes.size.toLong() &&
                try { sha256Hex(blob) == hash } catch (_: Exception) { false }
            if (!deduped) {
                blob.parentFile?.mkdirs()
                writeBytesAtomic(blob, request.bytes)
            }
            val entry = Entry(
                id = UUID.randomUUID().toString(),
                name = if (request.bundleId != null)
                    FileNameUtil.sanitizeRelativePath(request.displayName)
                else FileNameUtil.sanitize(request.displayName).ifBlank { "received_file" },
                hash = hash,
                size = request.bytes.size.toLong(),
                crcHex = request.crcHex,
                crcUnknown = request.crcUnknown,
                kind = request.kind,
                createdAt = createdAt,
                bundleId = request.bundleId,
                bundleTitle = request.bundleTitle,
            )
            all.add(entry)
            results.add(PutResult(entry, blob, deduped))
        }
        saveIndex(ctx, all)
        return results
    }

    /**
     * Archive a bundle of pre-staged files with ONE index write instead of a
     * per-entry commit (which is both O(n²) in index rewrites and leaves a
     * truncated bundle in history when entry k of n fails mid-loop).
     *
     * The index is only saved after every member has been hashed and moved
     * into the blob tree, so a mid-batch failure leaves history untouched;
     * blobs moved by the failed batch that no pre-existing entry references
     * are deleted in the failure unwind (no orphan space leak, retry-safe).
     * Callers own leftover staged files when the batch throws.
     */
    @Synchronized
    fun putFileBatch(ctx: Context, requests: List<PutFileRequest>): List<PutResult> {
        if (requests.isEmpty()) return emptyList()
        val all = loadIndex(ctx).toMutableList()
        val priorHashes = all.mapTo(HashSet()) { it.hash }
        val results = ArrayList<PutResult>(requests.size)
        val movedBlobs = ArrayList<File>()
        val createdAt = System.currentTimeMillis()
        try {
            for (request in requests) {
                val file = request.file
                if (!file.isFile) throw java.io.FileNotFoundException(file.absolutePath)
                val sourceLength = file.length()
                require(request.expectedSize == null || sourceLength == request.expectedSize) {
                    "staged file length differs from descriptor: ${file.name}"
                }
                val hash = sha256Hex(file)
                val blob = blobPath(ctx, hash)
                val deduped = blob.exists() && blob.length() == sourceLength &&
                    try { sha256Hex(blob) == hash } catch (_: Exception) { false }
                if (!deduped) {
                    blob.parentFile?.mkdirs()
                    moveFileAtomic(file, blob)
                    movedBlobs.add(blob)
                    if (!blob.isFile || blob.length() != sourceLength) {
                        throw java.io.IOException("content blob length changed during publish")
                    }
                }
                val entry = Entry(
                    id = UUID.randomUUID().toString(),
                    name = if (request.bundleId != null)
                        FileNameUtil.sanitizeRelativePath(request.displayName)
                    else FileNameUtil.sanitize(request.displayName).ifBlank { "received_file" },
                    hash = hash,
                    size = sourceLength,
                    crcHex = request.crcHex,
                    crcUnknown = request.crcUnknown,
                    kind = request.kind,
                    createdAt = createdAt,
                    bundleId = request.bundleId,
                    bundleTitle = request.bundleTitle,
                )
                all.add(entry)
                results.add(PutResult(entry, blob, deduped))
            }
            saveIndex(ctx, all)
        } catch (t: Throwable) {
            // Pre-commit failure unwind: blobs moved by THIS batch that no
            // pre-existing entry references are orphans — delete them so the
            // failure leaks no space and the batch is retryable from scratch.
            for (blob in movedBlobs) {
                if (blob.name !in priorHashes) {
                    try { blob.delete() } catch (_: Exception) {}
                }
            }
            throw t
        }
        // Index publication is the commit point. Remove staged files that a
        // dedupe hit left behind (the non-dedup path already moved them).
        for (i in results.indices) {
            val f = requests[i].file
            if (f.isFile && f.canonicalPath != results[i].path.canonicalPath) f.delete()
        }
        return results
    }

    /**
     * Archive an existing file (e.g. a fully-assembled large-transfer) into the
     * content-addressed store by streaming its hash and atomically moving it
     * into the blob tree — no full-file in-memory or on-disk copy. If index
     * publication fails, the task ledger retries against the verified blob.
     */
    @Synchronized
    fun putFile(
        ctx: Context,
        displayName: String,
        file: File,
        crcHex: String = "unknown",
        crcUnknown: Boolean = true,
        kind: String = "file",
        bundleId: String? = null,
        bundleTitle: String? = null,
        expectedSha256Hex: String? = null,
        expectedSize: Long? = null,
        stableEntryId: String? = null,
    ): PutResult {
        val all = loadIndex(ctx).toMutableList()
        val expectedHash = expectedSha256Hex?.lowercase()
        if (expectedHash != null) {
            require(expectedHash.length == 64 && expectedHash.all { it in '0'..'9' || it in 'a'..'f' }) {
                "invalid expected SHA-256 hash"
            }
        }
        val sourceExists = file.isFile
        val sourceLength = if (sourceExists) file.length() else expectedSize
            ?: throw java.io.FileNotFoundException(file.absolutePath)
        require(expectedSize == null || sourceLength == expectedSize) {
            "assembled file length differs from descriptor"
        }
        val hash = if (sourceExists) sha256Hex(file) else requireNotNull(expectedHash)
        require(expectedHash == null || hash == expectedHash) {
            "assembled file SHA-256 differs from descriptor"
        }
        val blob = blobPath(ctx, hash)
        val deduped = blob.exists() && blob.length() == sourceLength &&
            try { sha256Hex(blob) == hash } catch (_: Exception) { false }
        if (!deduped) {
            require(sourceExists) { "assembled source and verified content blob are both missing" }
            blob.parentFile?.mkdirs()
            moveFileAtomic(file, blob)
            if (!blob.isFile || blob.length() != sourceLength) {
                throw java.io.IOException("content blob length changed during publish")
            }
        }
        val existing = stableEntryId?.let { id -> all.firstOrNull { it.id == id } }
        if (existing != null) {
            require(existing.hash == hash && existing.size == sourceLength) {
                "stable content entry id conflicts with existing history"
            }
            if (file.canonicalPath != blob.canonicalPath) file.delete()
            return PutResult(existing, blob, true)
        }
        val entry = Entry(
            id = stableEntryId ?: UUID.randomUUID().toString(),
            name = if (bundleId != null)
                FileNameUtil.sanitizeRelativePath(displayName)
            else FileNameUtil.sanitize(displayName).ifBlank { "received_file" },
            hash = hash,
            size = blob.length(),
            crcHex = crcHex,
            crcUnknown = crcUnknown,
            kind = kind,
            createdAt = System.currentTimeMillis(),
            bundleId = bundleId,
            bundleTitle = bundleTitle,
        )
        all.add(entry)
        saveIndex(ctx, all)
        // Index publication is the commit point. Only now is it safe to remove
        // the task-owned assembled copy.
        if (file.canonicalPath != blob.canonicalPath) file.delete()
        return PutResult(entry, blob, deduped)
    }

    @Synchronized
    fun listEntries(ctx: Context): List<Entry> = loadIndex(ctx)

    @Synchronized
    fun getEntry(ctx: Context, id: String): Entry? =
        loadIndex(ctx).find { it.id == id }

    @Synchronized
    fun deleteEntry(ctx: Context, id: String): Boolean {
        val all = loadIndex(ctx).toMutableList()
        val idx = all.indexOfFirst { it.id == id }
        if (idx < 0) return false
        val removed = all.removeAt(idx)
        saveIndex(ctx, all)
        // Drop blob when no entry references it.
        if (all.none { it.hash == removed.hash }) {
            val blob = blobPath(ctx, removed.hash)
            if (blob.exists()) blob.delete()
        }
        return true
    }

    @Synchronized
    fun deleteBundle(ctx: Context, bundleId: String): Int {
        val all = loadIndex(ctx)
        val victims = all.filter { it.bundleId == bundleId }
        if (victims.isEmpty()) return 0
        val remain = all.filter { it.bundleId != bundleId }
        saveIndex(ctx, remain)
        val liveHashes = remain.map { it.hash }.toSet()
        for (v in victims) {
            if (v.hash !in liveHashes) {
                val blob = blobPath(ctx, v.hash)
                if (blob.exists()) blob.delete()
            }
        }
        return victims.size
    }

    @Synchronized
    fun clearAll(ctx: Context) {
        saveIndex(ctx, emptyList())
        val blobs = File(root(ctx), BLOBS)
        if (blobs.exists()) blobs.deleteRecursively()
        val segments = File(root(ctx), "seg")
        if (segments.exists()) segments.deleteRecursively()
    }

    /**
     * One-time import of legacy `…/received/` tree into the store, then rename
     * the old dir so we don't double-list.
     */
    @Synchronized
    fun migrateLegacyReceivedIfNeeded(ctx: Context) {
        val base = ctx.getExternalFilesDir(null) ?: return
        val legacy = File(base, "received")
        if (!legacy.exists()) return
        // Only migrate if store index is empty and legacy has content.
        if (loadIndex(ctx).isNotEmpty()) return
        val files = legacy.walkTopDown()
            .filter { it.isFile && !it.name.endsWith(".meta") }
            .toList()
        if (files.isEmpty()) {
            legacy.deleteRecursively()
            return
        }
        Log.i(TAG, "Migrating ${files.size} legacy received file(s) into ContentStore")
        for (f in files) {
            try {
                val meta = File(f.parentFile, "${f.name}.meta")
                var name = f.name
                var crcHex = "unknown"
                var crcUnknown = true
                var kind = "file"
                if (meta.exists()) {
                    val lines = meta.readLines()
                    name = lines.getOrElse(0) { f.name }
                    crcHex = lines.getOrElse(2) { "unknown" }.trim()
                    crcUnknown = crcHex == "unknown" || crcHex.isEmpty()
                    if (lines.getOrElse(4) { "" }.trim() == "kind=text") kind = "text"
                }
                // Bundle subdir → shared bundleId by parent folder name.
                val parent = f.parentFile
                val bundleId: String?
                val bundleTitle: String?
                if (parent != null && parent != legacy && parent.name.startsWith("发送_")) {
                    bundleId = "legacy-${parent.name}"
                    bundleTitle = parent.name
                } else {
                    bundleId = null
                    bundleTitle = null
                }
                putBytes(
                    ctx, name, f.readBytes(),
                    crcHex = crcHex, crcUnknown = crcUnknown, kind = kind,
                    bundleId = bundleId, bundleTitle = bundleTitle,
                )
            } catch (e: Exception) {
                Log.w(TAG, "migrate skip ${f.name}", e)
            }
        }
        // Keep a backup once, then remove to avoid dual listing.
        val bak = File(base, "received.bak.${System.currentTimeMillis()}")
        if (!legacy.renameTo(bak)) {
            legacy.deleteRecursively()
        }
    }

    private fun indexFile(ctx: Context) = File(root(ctx), INDEX)

    private fun loadIndex(ctx: Context): List<Entry> {
        val f = indexFile(ctx)
        if (!f.exists()) return emptyList()
        return try {
            val arr = JSONArray(f.readText())
            buildList {
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val entry = Entry(
                            id = o.getString("id"),
                            name = o.getString("name"),
                            hash = o.getString("hash"),
                            size = o.getLong("size"),
                            crcHex = o.optString("crcHex", "unknown"),
                            crcUnknown = o.optBoolean("crcUnknown", true),
                            kind = o.optString("kind", "file"),
                            createdAt = o.optLong("createdAt", 0L),
                            bundleId = o.optString("bundleId", "").ifEmpty { null },
                            bundleTitle = o.optString("bundleTitle", "").ifEmpty { null },
                        )
                    if (entry.size < 0 || entry.hash.length != 64 ||
                        !entry.hash.all { it in '0'..'9' || it.lowercaseChar() in 'a'..'f' }
                    ) {
                        throw IllegalArgumentException("invalid ContentStore entry at index $i")
                    }
                    add(entry)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "loadIndex failed", e)
            // Keep a byte-for-byte forensic copy, but leave index.json in place
            // and fail closed so no later mutation can silently replace it.
            val backup = File(f.parentFile, "index.corrupt.${f.lastModified()}.json")
            try {
                if (!backup.exists()) f.copyTo(backup)
            } catch (backupError: Exception) {
                Log.w(TAG, "failed to preserve corrupt index", backupError)
            }
            throw IllegalStateException(
                "接收历史索引已损坏，已停止写入以保护现有数据: ${backup.absolutePath}",
                e,
            )
        }
    }

    private fun saveIndex(ctx: Context, entries: List<Entry>) {
        val arr = JSONArray()
        for (e in entries) {
            arr.put(
                JSONObject().apply {
                    put("id", e.id)
                    put("name", e.name)
                    put("hash", e.hash)
                    put("size", e.size)
                    put("crcHex", e.crcHex)
                    put("crcUnknown", e.crcUnknown)
                    put("kind", e.kind)
                    put("createdAt", e.createdAt)
                    if (e.bundleId != null) put("bundleId", e.bundleId)
                    if (e.bundleTitle != null) put("bundleTitle", e.bundleTitle)
                }
            )
        }
        val f = indexFile(ctx)
        f.parentFile?.mkdirs()
        writeBytesAtomic(f, arr.toString().toByteArray(Charsets.UTF_8))
    }

    private fun writeBytesAtomic(target: File, bytes: ByteArray) {
        val atomic = AtomicFile(target)
        var out: java.io.FileOutputStream? = null
        try {
            out = atomic.startWrite()
            out.write(bytes)
            out.fd.sync()
            atomic.finishWrite(out)
            out = null
        } finally {
            if (out != null) atomic.failWrite(out)
        }
    }

    /** Move an assembled task into content storage without a second full copy. */
    private fun moveFileAtomic(source: File, target: File) {
        target.parentFile?.mkdirs()
        try {
            java.nio.file.Files.move(
                source.toPath(),
                target.toPath(),
                java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                java.nio.file.StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
            java.nio.file.Files.move(
                source.toPath(),
                target.toPath(),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING,
            )
        }
    }
}
