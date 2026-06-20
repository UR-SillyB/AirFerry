package com.easytransfer.app.scan

/**
 * JNI bridge to ZXing-C++ (libeasytransfer_zxing.so).
 *
 * Decodes a single QR code from a CameraX Y (luminance) plane. Returns the raw
 * byte payload, or null if no QR is found. Called on every analysis frame.
 *
 * Both entry points view the Y plane **in place** (the native side honors
 * `rowStride`), so no compacting copy of the padded plane is made on either
 * side of the JNI boundary.
 */
object ZxingDecoder {
    init {
        System.loadLibrary("easytransfer_zxing")
    }

    /**
     * Decode a QR in the full frame.
     *
     * @param yPlane the Y (luminance) plane bytes from ImageProxy
     * @param width image width in pixels
     * @param height image height in pixels
     * @param rowStride row stride of the Y plane (may include padding)
     * @return decoded byte payload, or null
     */
    external fun decodeY(yPlane: ByteArray, width: Int, height: Int, rowStride: Int): ByteArray?

    /**
     * Full-frame decode with bbox write-back. Used as a recovery path when the
     * center/tracked ROI has not locked onto the browser screen QR yet.
     *
     * On success [outBbox] receives `{minX, minY, maxX, maxY}` in full-frame
     * coordinates; on a miss it is left untouched.
     */
    external fun decodeYTracked(
        yPlane: ByteArray, width: Int, height: Int, rowStride: Int, outBbox: IntArray,
    ): ByteArray?

    /**
     * Zero-copy center-ROI decode. The native side builds a `cropped()` sub-view
     * of the padded Y plane at `(x0, y0)` of size `side×side`, so no per-row
     * arraycopy is needed to feed a region to ZXing.
     *
     * @param x0 top-left X of the region (pixels)
     * @param y0 top-left Y of the region (pixels)
     * @param side width/height of the square region
     * @return decoded byte payload, or null
     */
    external fun decodeYRegion(
        yPlane: ByteArray, width: Int, height: Int, rowStride: Int,
        x0: Int, y0: Int, side: Int,
    ): ByteArray?

    /**
     * Adaptive-tracking ROI decode. Like [decodeYRegion] but on success writes
     * the QR's full-frame bounding box `{minX, minY, maxX, maxY}` into
     * [outBbox] (which must be length ≥ 4). The caller feeds that bbox back as
     * the next frame's ROI hint, so once the QR is locked the decoder scans a
     * tight window instead of the fixed 70% center region.
     *
     * On a miss the payload is null and [outBbox] is left untouched.
     */
    external fun decodeYRegionTracked(
        yPlane: ByteArray, width: Int, height: Int, rowStride: Int,
        x0: Int, y0: Int, side: Int, outBbox: IntArray,
    ): ByteArray?

    /**
     * Multi-QR full-frame decode (experimental). Returns a flat buffer with
     * every valid QR's payload, or null if none found. Layout:
     *   [u32 count_LE][for each: u32 len_LE + len bytes payload]
     * Use [parseMulti] to split it into individual payloads.
     */
    external fun decodeMultiY(
        yPlane: ByteArray, width: Int, height: Int, rowStride: Int,
    ): ByteArray?

    /**
     * Split the flat little-endian buffer from [decodeMultiY] into the list of
     * individual code payloads. Returns an empty list for null/short input.
     */
    fun parseMulti(buf: ByteArray?): List<ByteArray> {
        if (buf == null || buf.size < 4) return emptyList()
        val count = u32le(buf, 0)
        val out = ArrayList<ByteArray>(count.coerceAtMost(64))
        var pos = 4
        var i = 0
        while (i < count && pos + 4 <= buf.size) {
            val len = u32le(buf, pos)
            pos += 4
            if (len <= 0 || pos + len > buf.size) break
            out.add(buf.copyOfRange(pos, pos + len))
            pos += len
            i++
        }
        return out
    }

    private fun u32le(b: ByteArray, o: Int): Int =
        (b[o].toInt() and 0xFF) or
            ((b[o + 1].toInt() and 0xFF) shl 8) or
            ((b[o + 2].toInt() and 0xFF) shl 16) or
            ((b[o + 3].toInt() and 0xFF) shl 24)
}
