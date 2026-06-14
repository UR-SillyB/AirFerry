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

    external fun receiverIngest(handle: Long, frameBytes: ByteArray, outBuf: ByteArray): Int
    external fun receiverIsComplete(handle: Long): Int
    external fun receiverAssembledLength(handle: Long): Int
    external fun receiverAssemble(handle: Long, outBuf: ByteArray): Int
    external fun receiverDestroy(handle: Long)

    // ---- File metadata (populated from descriptor frames) ----

    /** Original filename (UTF-8), or empty if not yet received. */
    external fun receiverFileName(handle: Long): String

    /** Original file size in bytes, or 0 if not yet received. */
    external fun receiverFileSize(handle: Long): Long

    /** CRC32 of the original file, or 0 if not yet received. */
    external fun receiverCrc32(handle: Long): Int
}
