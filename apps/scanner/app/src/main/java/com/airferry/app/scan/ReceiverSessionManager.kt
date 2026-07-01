package com.airferry.app.scan

import com.airferry.app.nativelib.NativeBridge
import org.json.JSONObject

/**
 * High-level receiver session manager.
 *
 * Wraps the Rust `transfer_engine` JNI. Lazily creates the native receiver
 * after the first frame reveals the session id + totals, then feeds every
 * decoded frame to it. Exposes progress as a parsed [Progress] snapshot.
 *
 * The frame wire format is parsed here (big-endian, 60-byte header + payload +
 * 4-byte footer) to extract the session metadata before the native receiver is
 * created. See qr-protocol/src/frame.rs for the authoritative layout.
 */
class ReceiverSessionManager {

    /** Parsed frame header (subset of fields needed by Kotlin). */
    data class FrameHeader(
        val magic: Int,
        val version: Int,
        val flags: Int,
        val sessionIdLo: Long,
        val sessionIdHi: Long,
        val sbn: Int,
        val esi: Int,
        /** Advisory until descriptor confirms; u32 on wire as unsigned Long. */
        val totalBlocks: Long,
        val totalSymbols: Long,
        val symbolSize: Long
    )

    data class Progress(
        val decodedSymbols: Int,
        val totalSymbols: Int,
        val receivedSymbols: Int,
        val framesSeen: Long,
        val framesDropped: Long,
        val framesCorrupt: Long,
        val decodedBlocks: Int,
        val totalBlocks: Int,
        val decodedFraction: Double,
        val lossRatio: Double,
        val complete: Boolean,
        val metaConfirmed: Boolean,
        val sessionMismatchStreak: Int
    )

    /**
     * Lightweight per-frame status decoded from the native `receiverIngest`
     * packed long. Carries only what the ingest path needs (completion +
     * re-init heuristics); the full progress is fetched on demand via
     * [progress] at the UI cadence.
     */
    data class IngestStatus(
        val complete: Boolean,
        /** True if this frame contributed a new symbol. */
        val accepted: Boolean,
        val mismatchStreak: Int,
        val receivedSymbols: Int
    ) {
        companion object {
            // Mirrors the Rust pack_ingest_status layout (see jni.rs).
            private const val ERROR_RECEIVED = 0xFFFFFFFFL.toInt()

            /** Decode a packed status word, or null on the error sentinel. */
            fun unpack(word: Long): IngestStatus? {
                val bits = word.toULong()
                // Error sentinel: received_symbols == u32::MAX.
                if (((bits shr 32) and 0xFFFFFFFFuL).toInt() == ERROR_RECEIVED) return null
                val complete = (bits and 1uL) != 0uL
                val accepted = ((bits shr 1) and 1uL) != 0uL
                val streak = ((bits shr 8) and 0xFFFFuL).toInt()
                val received = ((bits shr 32) and 0xFFFFFFFFuL).toInt()
                return IngestStatus(complete, accepted, streak, received)
            }
        }
    }

    private var handle: Long = 0L
    private var sessionIdLo: Long = 0L
    private var sessionIdHi: Long = 0L
    private var symbolSize: Int = 0
    /** Expose the decoded symbol size (bytes) for UI throughput calculation. */
    fun symbolSizeBytes(): Int = symbolSize
    private var initialized: Boolean = false
    private var estimatedTotalSymbols: Int = 0
    /// Consecutive mismatch count seen by Kotlin (driven from Rust streak).
    private var mismatchStreak: Int = 0
    /// True once at least one symbol has been accepted (no re-init after that).
    private var everAccepted: Boolean = false

    val isInitialized: Boolean get() = initialized

    fun getEstimatedTotalSymbols(): Int = estimatedTotalSymbols

    /** Parse + validate a frame's header. Returns null if not a valid ET frame. */
    fun parseHeader(bytes: ByteArray): FrameHeader? {
        if (bytes.size < 64) return null
        val magic = u16be(bytes, 0)
        if (magic != MAGIC) return null
        val version = bytes[2].toInt() and 0xFF
        if (version != PROTOCOL_VERSION) return null
        val flags = bytes[3].toInt() and 0xFF
        val sessionIdHi = u64be(bytes, 4)
        val sessionIdLo = u64be(bytes, 12)
        val sbn = u32be(bytes, 20)
        val esi = u32be(bytes, 24)
        // total_blocks / total_symbols are u32 on the wire but we only carry
        // them through as advisory metadata (the authoritative layout comes
        // from the descriptor). Hold them as Long so a near-2^32 value does not
        // arrive as a negative Int and confuse downstream comparisons.
        val totalBlocks = u32beLong(bytes, 28)
        val totalSymbols = u32beLong(bytes, 32)
        val symbolSize = u32beLong(bytes, 36)
        return FrameHeader(
            magic, version, flags, sessionIdLo, sessionIdHi,
            sbn, esi, totalBlocks, totalSymbols, symbolSize
        )
    }

    /** Ingest a decoded QR payload.
     *
     * The native receiver is **only** initialised from a descriptor frame
     * (FLAG_DESCRIPTOR).  Ordinary data frames are silently dropped until a
     * descriptor arrives.  This prevents a corrupted first QR decode (which
     * only passes magic+version but has a garbage session_id) from permanently
     * locking out every subsequent correct frame.
     *
     * Once initialised, a persistent session-mismatch streak with zero
     * accepted symbols triggers a forced re-init from the next descriptor that
     * arrives — covering the edge-case where the first descriptor itself was
     * corrupted but a later one is clean.
     *
     * Returns a lightweight [IngestStatus] (no JSON) so the hot ingest path
     * doesn't allocate/parse a string per frame. Call [progress] on the UI
     * refresh cadence for the full snapshot.
     */
    fun ingest(frameBytes: ByteArray): IngestStatus? {
        val header = parseHeader(frameBytes) ?: return null

        // Cache estimated total symbols from first frame for approximate progress
        if (estimatedTotalSymbols == 0 && header.totalSymbols > 0L) {
            estimatedTotalSymbols = header.totalSymbols.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        }

        val isDescriptor = (header.flags and FLAG_DESCRIPTOR) != 0

        // --- Lazy init: only from descriptor frames ---
        // 未初始化时只接受 descriptor 帧（携带权威 OTI），数据帧直接丢弃等待。
        // 这防止首个 QR 解码（仅过 magic+version 校验但 session_id 可能是垃圾）
        // 用错误 session_id 永久锁死后续所有正确帧。
        if (!initialized) {
            if (!isDescriptor) return null  // wait for a descriptor
            createReceiver(header)
            if (!initialized) return null
        }

        // --- Session-mismatch re-init ---
        // 若 mismatch streak 过高且从未接受过任何符号，首个 descriptor 很可能
        // 已损坏 → 销毁，等下一个 descriptor 重建（下一帧 ingest 回到上面的 lazy
        // init 块）。此处直接 return null，本帧不继续。
        if (initialized && !isDescriptor && mismatchStreak >= 3 && !everAccepted) {
            destroy()
            return null  // will re-init on next descriptor
        }

        // receiverIngest returns a packed status word (see IngestStatus). The
        // error sentinel (null from unpack) means a rejected frame — treat as
        // "nothing happened" without disturbing the re-init state machine.
        val status = IngestStatus.unpack(NativeBridge.receiverIngest(handle, frameBytes))
            ?: return null

        // Track mismatch streak for re-init logic above.
        if (status.mismatchStreak >= 3) {
            mismatchStreak = status.mismatchStreak
        } else if (status.accepted) {
            everAccepted = true
            mismatchStreak = 0
        }

        return status
    }

    /**
     * Full progress snapshot (parsed from the on-demand JSON). Intended to be
     * called at the UI refresh cadence (~7 Hz), NOT per-frame. Returns null if
     * the session isn't initialized or the native call fails.
     */
    fun progress(): Progress? {
        if (!initialized || handle == 0L) return null
        val jsonBytes = NativeBridge.receiverProgressJson(handle) ?: return null
        if (jsonBytes.isEmpty()) return null
        val nul = jsonBytes.indexOf(0)
        val len = if (nul >= 0) nul else jsonBytes.size
        val json = String(jsonBytes, 0, len)
        return parseProgress(json)
    }

    /** Create (or re-create) the native receiver from a parsed frame header. */
    private fun createReceiver(header: FrameHeader) {
        sessionIdLo = header.sessionIdLo
        sessionIdHi = header.sessionIdHi
        symbolSize = when {
            header.symbolSize > 0L && header.symbolSize <= Int.MAX_VALUE -> header.symbolSize.toInt()
            else -> 1024
        }
        val totalBlocks = header.totalBlocks.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        val totalSymbols = header.totalSymbols.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        handle = NativeBridge.receiverCreate(
            sessionIdLo, sessionIdHi,
            totalBlocks, totalSymbols, symbolSize
        )
        initialized = handle != 0L
        mismatchStreak = 0
        everAccepted = false
    }

    fun isComplete(): Boolean =
        initialized && NativeBridge.receiverIsComplete(handle) == 1

    /** Original filename from the descriptor, or empty. */
    fun fileName(): String =
        if (initialized) NativeBridge.receiverFileName(handle) else ""

    /** Original file size, or 0. */
    fun fileSize(): Long =
        if (initialized) NativeBridge.receiverFileSize(handle) else 0L

    /** Expected CRC32 (unsigned 32-bit in a Long), or 0. */
    fun crc32(): Long =
        if (initialized) NativeBridge.receiverCrc32(handle) else 0L

    /**
     * True if the descriptor supplied a real CRC32 (so the receiver should
     * verify it). Use this — NOT `crc32() == 0L` — to decide whether to
     * verify: CRC32 can legitimately be 0.
     */
    fun crc32Known(): Boolean =
        if (initialized) NativeBridge.receiverCrc32Known(handle) == 1 else false

    /** Recover the assembled file bytes, or null if not complete / on failure. */
    fun assemble(): ByteArray? {
        if (!initialized) return null
        val bytes = NativeBridge.receiverAssembleBytes(handle) ?: return null
        return bytes.takeIf { it.isNotEmpty() }
    }

    /** Rust-side reason when [assemble] returns null but [isComplete] is true. */
    fun lastAssembleError(): String =
        if (initialized) NativeBridge.receiverLastAssembleError(handle) else ""

    fun sessionIdHex(): String {
        val lo = java.lang.Long.toUnsignedString(sessionIdLo, 16).padStart(16, '0')
        val hi = java.lang.Long.toUnsignedString(sessionIdHi, 16).padStart(16, '0')
        return "$hi$lo"
    }

    fun destroy() {
        if (initialized && handle != 0L) {
            NativeBridge.receiverDestroy(handle)
            handle = 0L
            initialized = false
        }
    }

    private fun parseProgress(json: String): Progress {
        val o = JSONObject(json)
        // The Rust progress_json emits `frames_duplicate` and `frames_corrupt`
        // (there is no `frames_dropped` key). Treat "dropped" as the union of
        // duplicate and corrupt frames — i.e. every seen frame that did not
        // contribute new data — which is what the loss-ratio already reflects.
        val framesDuplicate = o.optLong("frames_duplicate")
        val framesCorrupt = o.optLong("frames_corrupt")
        return Progress(
            decodedSymbols = o.optInt("decoded_symbols"),
            totalSymbols = o.optInt("total_symbols"),
            receivedSymbols = o.optInt("received_symbols"),
            framesSeen = o.optLong("frames_seen"),
            framesDropped = framesDuplicate + framesCorrupt,
            framesCorrupt = framesCorrupt,
            decodedBlocks = o.optInt("decoded_blocks"),
            totalBlocks = o.optInt("total_blocks"),
            decodedFraction = o.optDouble("decoded_fraction"),
            lossRatio = o.optDouble("loss_ratio"),
            complete = o.optBoolean("complete"),
            metaConfirmed = o.optBoolean("meta_confirmed", false),
            sessionMismatchStreak = o.optInt("session_mismatch_streak", 0)
        )
    }

    companion object {
        const val MAGIC = 0x4554
        const val PROTOCOL_VERSION = 1
        const val FLAG_DESCRIPTOR = 0x01

        private fun u16be(b: ByteArray, o: Int): Int =
            ((b[o].toInt() and 0xFF) shl 8) or (b[o + 1].toInt() and 0xFF)
        private fun u32be(b: ByteArray, o: Int): Int =
            (u16be(b, o) shl 16) or u16be(b, o + 2)
        /** Read a big-endian u32 as an unsigned Long (0..=0xFFFFFFFF), so a value
         *  near 2^32 is not reinterpreted as a negative Int. */
        private fun u32beLong(b: ByteArray, o: Int): Long =
            u32be(b, o).toLong() and 0xFFFFFFFFL
        private fun u64be(b: ByteArray, o: Int): Long {
            val hi = u32be(b, o).toLong() and 0xFFFFFFFFL
            val lo = u32be(b, o + 4).toLong() and 0xFFFFFFFFL
            return (hi shl 32) or lo
        }
    }
}
