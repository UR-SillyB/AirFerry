package com.easytransfer.app.scan

import com.easytransfer.app.nativelib.NativeBridge
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
        val totalBlocks: Int,
        val totalSymbols: Int,
        val symbolSize: Int
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
        val metaConfirmed: Boolean
    )

    private var handle: Long = 0L
    private var sessionIdLo: Long = 0L
    private var sessionIdHi: Long = 0L
    private var symbolSize: Int = 0
    private var initialized: Boolean = false
    private var estimatedTotalSymbols: Int = 0

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
        val totalBlocks = u32be(bytes, 28)
        val totalSymbols = u32be(bytes, 32)
        val symbolSize = u32be(bytes, 36)
        return FrameHeader(
            magic, version, flags, sessionIdLo, sessionIdHi,
            sbn, esi, totalBlocks, totalSymbols, symbolSize
        )
    }

    /** Ingest a decoded QR payload. Lazily initializes the native receiver. */
    fun ingest(frameBytes: ByteArray): Progress? {
        val header = parseHeader(frameBytes) ?: return null

        // Cache estimated total symbols from first frame for approximate progress
        if (estimatedTotalSymbols == 0 && header.totalSymbols > 0) {
            estimatedTotalSymbols = header.totalSymbols
        }

        if (!initialized) {
            sessionIdLo = header.sessionIdLo
            sessionIdHi = header.sessionIdHi
            symbolSize = if (header.symbolSize > 0) header.symbolSize else 1024
            handle = NativeBridge.receiverCreate(
                sessionIdLo, sessionIdHi,
                header.totalBlocks, header.totalSymbols, symbolSize
            )
            initialized = handle != 0L
        }

        if (!initialized) return null

        // receiverIngest now returns a freshly-allocated byte[] (progress JSON +
        // trailing NUL) instead of writing into a fixed-size buffer, which used
        // to truncate on long transfers and stall the UI at 0%.
        val jsonBytes = NativeBridge.receiverIngest(handle, frameBytes) ?: return null
        if (jsonBytes.isEmpty()) return null
        val nul = jsonBytes.indexOf(0)
        val len = if (nul >= 0) nul else jsonBytes.size
        val json = String(jsonBytes, 0, len)
        return parseProgress(json)
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

    /** Recover the assembled file bytes, or null if not complete. */
    fun assemble(): ByteArray? {
        if (!initialized) return null
        val len = NativeBridge.receiverAssembledLength(handle)
        if (len <= 0) return null
        val out = ByteArray(len)
        val n = NativeBridge.receiverAssemble(handle, out)
        return if (n > 0) out else null
    }

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
            metaConfirmed = o.optBoolean("meta_confirmed", false)
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
        private fun u64be(b: ByteArray, o: Int): Long {
            val hi = u32be(b, o).toLong() and 0xFFFFFFFFL
            val lo = u32be(b, o + 4).toLong() and 0xFFFFFFFFL
            return (hi shl 32) or lo
        }
    }
}
