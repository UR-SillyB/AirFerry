package com.airferry.app.scan

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
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

    fun root(ctx: Context): File {
        val base = ctx.getExternalFilesDir(null) ?: ctx.filesDir
        return File(base, DIR_NAME).also { if (!it.exists()) it.mkdirs() }
    }

    fun blobPath(ctx: Context, hash: String): File {
        val h = hash.lowercase()
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
        val hash = sha256Hex(bytes)
        val blob = blobPath(ctx, hash)
        val deduped = blob.exists() && blob.length() == bytes.size.toLong()
        if (!deduped) {
            blob.parentFile?.mkdirs()
            blob.writeBytes(bytes)
        }
        val entry = Entry(
            id = UUID.randomUUID().toString(),
            name = FileNameUtil.sanitize(displayName).ifBlank { "received_file" },
            hash = hash,
            size = bytes.size.toLong(),
            crcHex = crcHex,
            crcUnknown = crcUnknown,
            kind = kind,
            createdAt = System.currentTimeMillis(),
            bundleId = bundleId,
            bundleTitle = bundleTitle,
        )
        appendEntry(ctx, entry)
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
                    add(
                        Entry(
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
                    )
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "loadIndex failed", e)
            emptyList()
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
        f.writeText(arr.toString())
    }

    private fun appendEntry(ctx: Context, entry: Entry) {
        val all = loadIndex(ctx).toMutableList()
        all.add(entry)
        saveIndex(ctx, all)
    }
}
