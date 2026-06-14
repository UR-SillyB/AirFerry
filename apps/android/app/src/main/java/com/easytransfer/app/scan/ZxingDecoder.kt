package com.easytransfer.app.scan

/**
 * JNI bridge to ZXing-C++ (libeasytransfer_zxing.so).
 *
 * Decodes a single QR code from a CameraX Y (luminance) plane. Returns the raw
 * byte payload, or null if no QR is found. Called on every analysis frame.
 */
object ZxingDecoder {
    init {
        System.loadLibrary("easytransfer_zxing")
    }

    /**
     * @param yPlane the Y (luminance) plane bytes from ImageProxy
     * @param width image width in pixels
     * @param height image height in pixels
     * @param rowStride row stride of the Y plane
     * @return decoded byte payload, or null
     */
    external fun decodeY(yPlane: ByteArray, width: Int, height: Int, rowStride: Int): ByteArray?
}
