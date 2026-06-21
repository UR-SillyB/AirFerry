package com.airferry.app.scan

/**
 * JNI bridge to ZXing-C++ (libairferry_zxing.so).
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
        System.loadLibrary("airferry_zxing")
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
     * Multi-QR full-frame decode (cold path). Returns a flat buffer with every
     * valid QR's payload + full-frame bbox, or null if none found. Layout:
     *   [u32 count_LE][for each: u32 len_LE + len bytes payload + 4×s32 bbox]
     * Use [parseMulti] to split it into individual payloads and bboxes.
     */
    external fun decodeMultiY(
        yPlane: ByteArray, width: Int, height: Int, rowStride: Int,
    ): ByteArray?

    /**
     * Multi-QR TRACKED region decode (hot path). For each bbox hint in [hints]
     * (packed {minX,minY,maxX,maxY}, [hintCount] rects), crops a zero-copy
     * expanded window (by [marginFrac] of the code size) and runs ReadBarcode
     * (singular) — avoiding the full-frame finder scan. Returns the same flat
     * layout as [decodeMultiY], with bboxes translated back to full-frame coords.
     * Pass null/empty hints to fall back to a full-frame scan via [decodeMultiY].
     */
    external fun decodeMultiYTracked(
        yPlane: ByteArray, width: Int, height: Int, rowStride: Int,
        hints: IntArray?, hintCount: Int, marginFrac: Float,
    ): ByteArray?

    /** One decoded multi-QR code: payload + its full-frame bbox. */
    data class MultiResult(
        val payload: ByteArray,
        /** {minX, minY, maxX, maxY} in full-frame pixel coords. */
        val bbox: IntArray,
    )

    /**
     * Split the flat little-endian buffer from [decodeMultiY] /
     * [decodeMultiYTracked] into individual {payload, bbox} pairs. Each record
     * is `[u32 len_LE][len bytes][4×s32 bbox]`. Returns empty for null/short input.
     */
    fun parseMulti(buf: ByteArray?): List<MultiResult> {
        if (buf == null || buf.size < 4) return emptyList()
        val count = u32le(buf, 0)
        val out = ArrayList<MultiResult>(count.coerceAtMost(64))
        var pos = 4
        var i = 0
        while (i < count && pos + 4 <= buf.size) {
            val len = u32le(buf, pos)
            pos += 4
            if (len <= 0 || pos + len > buf.size) break
            val payload = buf.copyOfRange(pos, pos + len)
            pos += len
            if (pos + 16 > buf.size) break  // need 4×s32 bbox
            val bbox = intArrayOf(
                s32le(buf, pos), s32le(buf, pos + 4),
                s32le(buf, pos + 8), s32le(buf, pos + 12),
            )
            pos += 16
            out.add(MultiResult(payload, bbox))
            i++
        }
        return out
    }

    private fun s32le(b: ByteArray, o: Int): Int =
        (b[o].toInt()) or
            (b[o + 1].toInt() shl 8) or
            (b[o + 2].toInt() shl 16) or
            (b[o + 3].toInt() shl 24)

    private fun u32le(b: ByteArray, o: Int): Int =
        (b[o].toInt() and 0xFF) or
            ((b[o + 1].toInt() and 0xFF) shl 8) or
            ((b[o + 2].toInt() and 0xFF) shl 16) or
            ((b[o + 3].toInt() and 0xFF) shl 24)
}
