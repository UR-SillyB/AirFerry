package com.airferry.app.scan

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Multi-file bundle container parser — mirrors the browser sender's
 * `bundle.ts` byte-for-byte so the two sides stay interoperable.
 *
 * See `apps/browser-extension/src/wasm/bundle.ts` for the authoritative
 * format description. In short:
 *
 *   offset  size   field
 *   0       8      magic: ASCII "ETBUNDL1"
 *   8       2      version: u16 (big-endian) = 1
 *   10      2      file_count: u16
 *   12      …      file_count × { u16 name_len, name_len name UTF-8,
 *                                 u64 size, size content }
 *
 * The sender only emits a bundle when ≥2 files are selected. A single-file
 * transfer never carries this magic, so the bundle path is transparent to old
 * flows.
 *
 * All parsing is bounds-checked and returns `null` on any malformed input so
 * the caller can fall back to treating the bytes as a plain single file.
 */
object BundleParser {

    private val MAGIC = byteArrayOf(
        'E'.code.toByte(), 'T'.code.toByte(), 'B'.code.toByte(), 'U'.code.toByte(),
        'N'.code.toByte(), 'D'.code.toByte(), 'L'.code.toByte(), '1'.code.toByte()
    )

    data class BundleFile(
        val name: String,
        val data: ByteArray
    )

    data class Bundle(
        val files: List<BundleFile>
    )

    /** True if `bytes` starts with the 8-byte bundle magic. */
    fun isBundle(bytes: ByteArray): Boolean {
        if (bytes.size < 12) return false
        for (i in MAGIC.indices) {
            if (bytes[i] != MAGIC[i]) return false
        }
        return true
    }

    /**
     * Parse a bundle. Returns `null` on any structural problem (bad magic,
     * truncated entry, declared length beyond the buffer). The caller should
     * treat `null` as "not a bundle / corrupt" and fall back to single-file
     * handling.
     */
    fun parse(bytes: ByteArray): Bundle? {
        if (!isBundle(bytes)) return null
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        buf.position(MAGIC.size) // skip magic
        val version = buf.short.toInt() and 0xFFFF
        if (version != 1) return null
        val count = buf.short.toInt() and 0xFFFF
        if (count == 0) return null

        val files = ArrayList<BundleFile>(count)
        for (i in 0 until count) {
            // Need at least: u16 name_len (2) + u64 size (8) = 10 bytes.
            if (buf.remaining() < 2) return null
            val nameLen = buf.short.toInt() and 0xFFFF
            if (buf.remaining() < nameLen + 8) return null
            val nameBytes = ByteArray(nameLen)
            buf.get(nameBytes)
            val name = String(nameBytes, Charsets.UTF_8)
            val size = buf.long
            // Defend against a malicious/over-long declared size.
            if (size < 0 || size > Int.MAX_VALUE.toLong()) return null
            if (buf.remaining() < size.toInt()) return null
            val data = ByteArray(size.toInt())
            buf.get(data)
            files.add(BundleFile(name, data))
        }
        return Bundle(files)
    }
}
