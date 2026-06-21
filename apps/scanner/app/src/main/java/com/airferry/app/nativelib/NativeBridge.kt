package com.airferry.app.nativelib

/**
 * JNI bridge to the Rust `transfer_engine` library (libtransfer_engine.so).
 *
 * Native methods read/write Kotlin `ByteArray`s via the JNIEnv function table
 * (GetByteArrayRegion / SetByteArrayRegion) — the standard, ABI-stable path.
 * The handle is a raw pointer stored as Long.
 */
object NativeBridge {
    init {
        System.loadLibrary("transfer_engine")
    }

    /** Create a receiver session. Returns an opaque pointer (Long). */
    external fun receiverCreate(
        sessionIdLo: Long,
        sessionIdHi: Long,
        totalBlocks: Int,
        totalSymbols: Int,
        symbolSize: Int
    ): Long

    /**
     * Ingest a frame. Returns a packed status word (see [IngestStatus]) instead
     * of a per-frame JSON string: the UI refreshes only ~7 Hz, so building and
     * parsing a JSON on every decoded frame is wasted work. The packed word
     * carries completion, accepted-flag, mismatch streak, and received-symbol
     * count — enough for the ingest path to decide completion + re-init. Fetch
     * the full progress via [receiverProgressJson] at the UI cadence.
     */
    external fun receiverIngest(handle: Long, frameBytes: ByteArray): Long

    /**
     * On-demand progress query (NUL-terminated JSON byte[], or empty on error).
     * Call at the UI refresh cadence (~7 Hz), not per-frame.
     */
    external fun receiverProgressJson(handle: Long): ByteArray

    external fun receiverIsComplete(handle: Long): Int
    /**
     * Recover the assembled file as a freshly-allocated `byte[]`, or an empty
     * array / null if not complete. Single atomic call (replaces the old
     * length+fill pair that truncated > 2 GB files via a `jint` length and had a
     * length/fill race).
     */
    external fun receiverAssembleBytes(handle: Long): ByteArray?
    external fun receiverDestroy(handle: Long)

    // ---- File metadata (populated from descriptor frames) ----

    /** Original filename (UTF-8), or empty if not yet received. */
    external fun receiverFileName(handle: Long): String

    /** Original file size in bytes, or 0 if not yet received. */
    external fun receiverFileSize(handle: Long): Long

    /**
     * CRC32 of the original file as an unsigned 32-bit value carried in a
     * `Long` (0..=0xFFFFFFFF), or 0 if not yet received. Returned as Long so
     * the full unsigned range survives the JNI boundary (Kotlin `Int` is
     * signed and would flip high-bit CRC values negative).
     */
    external fun receiverCrc32(handle: Long): Long

    /**
     * 1 if the descriptor supplied a real CRC32 the receiver should verify,
     * 0 if the CRC is unknown (v1 descriptor / not yet received). Use this
     * instead of `receiverCrc32() == 0L` to decide whether to verify: CRC32
     * can legitimately be 0, and the old `== 0L` sentinel mislabelled such
     * files as "unverified".
     */
    external fun receiverCrc32Known(handle: Long): Int
}
