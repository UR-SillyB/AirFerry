package com.airferry.app.scan

import com.airferry.app.nativelib.NativeBridge
import org.json.JSONObject

/**
 * High-level receiver session manager (AF2 protocol).
 *
 * Wraps the Rust `transfer_engine` native library via JNI. No wire-format
 * parsing happens on the Kotlin side (SPEC §9): frames pass straight to the
 * native state machine, and the packed IngestStatus word / snapshot JSON are
 * the only consumed surfaces.
 */
class ReceiverSessionManager {

    data class Progress(
        val totalSymbols: Int,
        val decodedSymbols: Int,
        val receivedSymbols: Int,
        val decodedBlocks: Int,
        val totalBlocks: Int,
        val decodedFraction: Double,
        val lossRatio: Double,
        val framesSeen: Long,
        val framesDuplicate: Int,
        val framesCorrupt: Int,
        val metaConfirmed: Boolean,
        val symbolSize: Int,
        val complete: Boolean,
        val mismatchStreak: Int = 0
    )

    fun progress(): Progress? {
        if (!initialized) return null
        val jsonBytes = NativeBridge.receiverProgressJson(handle) ?: return null
        val nul = jsonBytes.indexOf(0)
        val len = if (nul >= 0) nul else jsonBytes.size
        val json = String(jsonBytes, 0, len)
        return try {
            val o = JSONObject(json)
            // Track the wire symbol size T reported by Rust (it is observed
            // from the first accepted frame; 1024 is only the pre-lock guess).
            symbolSize = o.optInt("symbol_size", symbolSize)
            Progress(
                totalSymbols = o.optInt("total_symbols", 1024),
                decodedSymbols = o.optInt("decoded_symbols", 0),
                receivedSymbols = o.optInt("received_symbols", 0),
                decodedBlocks = o.optInt("decoded_blocks", 0),
                totalBlocks = o.optInt("total_blocks", 1),
                decodedFraction = o.optDouble("decoded_fraction", 0.0),
                lossRatio = o.optDouble("loss_ratio", 0.0),
                framesSeen = o.optLong("frames_seen", 0L),
                framesDuplicate = o.optInt("frames_duplicate", 0),
                framesCorrupt = o.optInt("frames_corrupt", 0),
                metaConfirmed = o.optBoolean("meta_confirmed", false),
                symbolSize = o.optInt("symbol_size", 1024),
                complete = o.optBoolean("complete", false),
                mismatchStreak = o.optInt("session_mismatch_streak", 0)
            )
        } catch (_: Exception) {
            null
        }
    }

    fun getEstimatedTotalSymbols(): Int {
        val snap = snapshot()
        if (!snap.metaConfirmed || symbolSize <= 0) return 0
        val total = (snap.totalRawSize + symbolSize - 1) / symbolSize
        return total.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }

    data class IngestStatus(
        val complete: Boolean,
        val accepted: Boolean,
        val manifestReady: Boolean,
        val chunkReady: Boolean,
        /** Bit 4: a foreign transfer took over the session. The ONLY signal
         * the host may use to discard transfer artifacts — the historical
         * `accepted && receivedSymbols == 0` heuristic also matched the first
         * accepted META of a §12-resumed session (counter still zero). */
        val relocked: Boolean,
        val mismatchStreak: Int,
        val receivedSymbols: Int
    ) {
        companion object {
            private const val ERROR_RECEIVED = 0xFFFFFFFFL.toInt()

            fun unpack(word: Long): IngestStatus? {
                val bits = word.toULong()
                if (((bits shr 32) and 0xFFFFFFFFuL).toInt() == ERROR_RECEIVED) return null
                val complete = (bits and 1uL) != 0uL
                val accepted = ((bits shr 1) and 1uL) != 0uL
                val manifestReady = ((bits shr 2) and 1uL) != 0uL
                val chunkReady = ((bits shr 3) and 1uL) != 0uL
                val relocked = ((bits shr 4) and 1uL) != 0uL
                val streak = ((bits shr 8) and 0xFFFFuL).toInt()
                val received = ((bits shr 32) and 0xFFFFFFFFuL).toInt()
                return IngestStatus(complete, accepted, manifestReady, chunkReady, relocked, streak, received)
            }
        }
    }

    private var handle: Long = 0L
    private var initialized: Boolean = false
    // Written under the ingest lock (worker) via progress(), read by the main
    // thread for the rate display — volatile so the UI doesn't pin a stale
    // pre-lock 1024 forever.
    @Volatile
    private var symbolSize: Int = 1024

    /**
     * Set by [destroy]. A decode-pool worker can still flush a straggler
     * batch after the owning scan screen is torn down; without this flag
     * [ingest] would re-create a native session that nobody ever destroys
     * (Rust-side leak) and poke a dead Activity's UI thread.
     */
    @Volatile
    private var destroyed: Boolean = false

    val isInitialized: Boolean get() = initialized

    fun symbolSizeBytes(): Int = symbolSize

    fun ingest(frameBytes: ByteArray): IngestStatus? {
        if (destroyed) return null
        if (!initialized) {
            handle = NativeBridge.receiverCreate(0L, 0L)
            initialized = handle != 0L
            cachedSnapshot = null
        }
        if (!initialized) return null
        val status = IngestStatus.unpack(NativeBridge.receiverIngest(handle, frameBytes))
        if (status != null && status.relocked) {
            // Relocked in native AF2: invalidate stale snapshot cache
            cachedSnapshot = null
        }
        return status
    }

    fun isComplete(): Boolean =
        initialized && NativeBridge.receiverIsComplete(handle) == 1

    /** Verify a staged chunk against the ROOT-bound Manifest table (§11). */
    fun verifyChunk(index: Int, rawBytes: ByteArray): Boolean =
        initialized && NativeBridge.receiverVerifyChunk(handle, index, rawBytes)

    /** Run §13 ⑧⑨ integrity chain over the reassembled canonical stream. */
    fun verifyFinalStream(streamBytes: ByteArray): Boolean =
        initialized && NativeBridge.receiverVerifyFinalStream(handle, streamBytes)

    /** Begin bounded-memory §13 ⑧⑨ final verification. */
    fun finalVerifyBegin(): Boolean =
        initialized && NativeBridge.receiverFinalVerifyBegin(handle)

    /** Feed the next contiguous canonical-stream block. */
    fun finalVerifyFeed(streamBytes: ByteArray): Boolean =
        initialized && NativeBridge.receiverFinalVerifyFeed(handle, streamBytes)

    /** Finish bounded-memory §13 ⑧⑨ final verification. */
    fun finalVerifyFinish(): Boolean =
        initialized && NativeBridge.receiverFinalVerifyFinish(handle)

    /** Restore session from stored ROOT frame bytes + completed chunk indices (§12 resume). */
    fun resume(rootFrameBytes: ByteArray, completedIndices: IntArray): Boolean {
        if (!initialized) {
            handle = NativeBridge.receiverCreate(0L, 0L)
            initialized = handle != 0L
            cachedSnapshot = null
        }
        return initialized && NativeBridge.receiverResume(handle, rootFrameBytes, completedIndices)
    }

    /**
     * Evict one chunk from both ledgers after a spill re-verification failure
     * (§11/§12): the sender's next epoch re-supplies it.
     */
    fun invalidateChunk(index: Int): Boolean =
        initialized && NativeBridge.receiverInvalidateChunk(handle, index)

    data class ManifestEntry(
        val kind: Int,
        val path: String,
        val savePath: String,
        val offset: Long,
        val size: Long
    )

    /** Parsed `ReceiverSnapshotV2`. */
    data class Snapshot(
        val metaConfirmed: Boolean,
        val transferIdHex: String,
        val contentIdHex: String,
        /** Canonical ROOT frame bytes (for the §12 resume ledger). */
        val rootFrameBytes: ByteArray = ByteArray(0),
        val totalRawSize: Long,
        val entryCount: Int,
        val chunkCount: Int,
        val chunkRawSize: Int,
        val entries: List<ManifestEntry> = emptyList(),
        /** v1-magic frames rejected so far; > 0 ⇒ peer runs protocol 1. */
        val legacyPeerFrames: Int = 0
    )

    private var cachedSnapshot: Snapshot? = null

    fun snapshot(): Snapshot {
        if (!initialized) return Snapshot(false, "", "", ByteArray(0), 0L, 0, 0, 0, emptyList(), 0)
        cachedSnapshot?.let { snap ->
            // Freeze only once the Manifest is decoded. `meta_confirmed` in the
            // AF2 snapshot merely means the ROOT locked — freezing there (as a
            // v1-era refactor did) pins `entries = []` for the whole session
            // and staging falls back to one nameless concatenated file.
            if (snap.metaConfirmed && snap.entries.isNotEmpty()) return snap
        }
        val json = NativeBridge.receiverSnapshotJson(handle)
            ?: return cachedSnapshot
                ?: Snapshot(false, "", "", ByteArray(0), 0L, 0, 0, 0, emptyList(), 0)
        return try {
            val o = JSONObject(json)
            val rootHex = o.optString("root_frame_hex", "")
            val entriesList = mutableListOf<ManifestEntry>()
            val arr = o.optJSONArray("entries")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val item = arr.getJSONObject(i)
                    val path = item.optString("path", "")
                    entriesList.add(
                        ManifestEntry(
                            kind = item.optInt("kind", 1),
                            path = path,
                            // §7.2 save-time sanitized name (may equal path).
                            savePath = item.optString("save_path", path),
                            offset = item.optLong("offset", 0L),
                            size = item.optLong("size", 0L)
                        )
                    )
                }
            }
            val snap = Snapshot(
                metaConfirmed = o.optBoolean("meta_confirmed", false),
                transferIdHex = o.optString("transfer_id_hex", ""),
                contentIdHex = o.optString("content_id_hex", ""),
                rootFrameBytes = hexToBytes(rootHex),
                totalRawSize = o.optLong("total_raw_size", 0L),
                entryCount = o.optInt("entry_count", 0),
                chunkCount = o.optInt("chunk_count", 0),
                chunkRawSize = o.optInt("chunk_raw_size", 0),
                entries = entriesList,
                legacyPeerFrames = o.optInt("legacy_peer_frames", 0)
            )
            cachedSnapshot = snap
            snap
        } catch (_: Exception) {
            cachedSnapshot
                ?: Snapshot(false, "", "", ByteArray(0), 0L, 0, 0, 0, emptyList(), 0)
        }
    }

    private fun hexToBytes(s: String): ByteArray {
        if (s.length % 2 != 0) return ByteArray(0)
        return ByteArray(s.length / 2) { i ->
            ((Character.digit(s[i * 2], 16) shl 4) +
                Character.digit(s[i * 2 + 1], 16)).toByte()
        }
    }

    fun fileName(): String {
        val snap = snapshot()
        val nonDir = snap.entries.filter { it.kind != 3 }
        if (nonDir.size == 1) return nonDir[0].path
        if (nonDir.size > 1) return "多文件传输包 (${nonDir.size} 项)"
        if (snap.entryCount > 1) return "多文件传输包 (${snap.entryCount} 项)"
        return "文件传输"
    }
    fun fileSize(): Long = snapshot().totalRawSize
    fun isSegmented(): Boolean = snapshot().chunkCount > 1
    fun segmentIndex(): Int = 0
    fun segmentCount(): Int = snapshot().chunkCount.coerceAtLeast(1)
    fun rootOriginalSize(): Long = snapshot().totalRawSize
    fun compressedSize(): Long = snapshot().totalRawSize
    fun originalSize(): Long = snapshot().totalRawSize

    fun assemble(): ByteArray? {
        if (!initialized) return null
        return NativeBridge.receiverAssembleBytes(handle)
    }

    fun assembleChunk(index: Int): ByteArray? {
        if (!initialized) return null
        return NativeBridge.receiverAssembleChunk(handle, index)
    }

    /**
     * Index of the chunk completed by the most recent ChunkReady frame, or -1.
     * Persist it with [assembleChunk] then release it with [forgetChunk] so
     * native memory stays bounded by one chunk instead of the whole object.
     */
    fun lastChunkIndex(): Int {
        if (!initialized) return -1
        return NativeBridge.receiverLastChunkIndex(handle)
    }

    /** Release a persisted chunk from native memory. True when it was resident. */
    fun forgetChunk(index: Int): Boolean {
        if (!initialized) return false
        return NativeBridge.receiverForgetChunk(handle, index)
    }

    /**
     * Drain the chunk completed by the frame just ingested: hand it to
     * [sink] and evict it from native memory. Must be called on the ingest
     * thread right after [ingest] reported `chunkReady` (the ingest path is
     * serialized, so the drain cannot race another ingest).
     */
    fun drainLastChunk(sink: (index: Int, chunkRawSize: Int, bytes: ByteArray) -> Unit) {
        val index = lastChunkIndex()
        if (index < 0) return
        val bytes = assembleChunk(index) ?: return
        val chunkRawSize = snapshot().chunkRawSize
        sink(index, chunkRawSize, bytes)
        forgetChunk(index)
    }

    fun destroy() {
        destroyed = true
        if (initialized && handle != 0L) {
            NativeBridge.receiverDestroy(handle)
            handle = 0L
            initialized = false
            cachedSnapshot = null
        }
    }

    companion object {
        const val MAGIC = 0x4146 // ASCII 'AF' (protocol 2)
        const val PROTOCOL_VERSION = 2
    }
}
