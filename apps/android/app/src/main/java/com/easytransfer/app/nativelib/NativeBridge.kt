package com.easytransfer.app.nativelib

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
     * Ingest a frame. Returns a freshly-allocated byte[] holding the progress
     * JSON (NUL-terminated), or null/empty array on error. The array is sized to
     * the exact JSON length, so there is no fixed cap that could truncate
     * progress updates on long transfers.
     */
    external fun receiverIngest(handle: Long, frameBytes: ByteArray): ByteArray?
    external fun receiverIsComplete(handle: Long): Int
    external fun receiverAssembledLength(handle: Long): Int
    external fun receiverAssemble(handle: Long, outBuf: ByteArray): Int
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
}
