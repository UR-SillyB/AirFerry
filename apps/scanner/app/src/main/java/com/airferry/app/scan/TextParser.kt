package com.airferry.app.scan

/**
 * Text payload parser — mirrors the browser sender's `text.ts` byte-for-byte.
 *
 * A text transfer is, at the payload layer, just a single-file object: the
 * sender wraps the user's text in an 8-byte magic prefix and feeds the bytes
 * through the same compress → RaptorQ → QR pipeline as a file. After recovery
 * + decompression, the receiver detects the magic and decodes the UTF-8 text.
 *
 * This mirrors the existing bundle-magic pattern (`BundleParser`): the
 * text/file distinction lives in the payload byte layer, NOT in the descriptor,
 * so the descriptor / protocol layer stays unchanged and old receivers stay
 * compatible (an old receiver that doesn't know this magic falls through to
 * single-file handling and saves the bytes as a .txt).
 *
 * See `apps/sender/src/wasm/text.ts` for the authoritative format.
 *
 *   offset  size   field
 *   0       8      magic: ASCII "ETTEXTv1" (0x45 54 54 45 58 54 76 31)
 *   8       …      UTF-8 text bytes (no length prefix; delimited by the
 *                  transfer-level original_size / compressed_size)
 */
object TextParser {

    private val MAGIC = byteArrayOf(
        'E'.code.toByte(), 'T'.code.toByte(), 'T'.code.toByte(), 'E'.code.toByte(),
        'X'.code.toByte(), 'T'.code.toByte(), 'v'.code.toByte(), '1'.code.toByte()
    )

    /** True if `bytes` starts with the 8-byte text magic. */
    fun isText(bytes: ByteArray): Boolean {
        if (bytes.size < 8) return false
        for (i in MAGIC.indices) {
            if (bytes[i] != MAGIC[i]) return false
        }
        return true
    }

    /**
     * Decode the text payload: strip the 8-byte magic and UTF-8-decode the rest.
     * Returns `null` if [bytes] does not carry the magic or the tail is not
     * valid UTF-8. The caller should treat `null` as "not a text payload /
     * corrupt" and fall back to single-file handling.
     */
    fun parse(bytes: ByteArray): String? {
        if (!isText(bytes)) return null
        return try {
            String(bytes, MAGIC.size, bytes.size - MAGIC.size, Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }
}
