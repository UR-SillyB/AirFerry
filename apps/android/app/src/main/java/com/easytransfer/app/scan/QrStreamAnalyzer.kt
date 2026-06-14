package com.easytransfer.app.scan

import android.annotation.SuppressLint
import android.content.Context
import android.util.Log
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import java.nio.ByteBuffer

/**
 * CameraX [ImageAnalysis.Analyzer] that decodes QR codes from the live video
 * stream on every frame and forwards decoded payloads to a callback.
 *
 * Implements the required "real-time video stream recognition" (not screenshot
 * mode): CameraX feeds YUV_420_888 frames continuously, and we run ZXing-C++
 * on the luminance plane of each one.
 *
 * @param onFrame called with the decoded byte payload when a QR is found
 */
class QrStreamAnalyzer(
    private val context: Context,
    private val onFrame: (ByteArray) -> Unit
) : ImageAnalysis.Analyzer {

    private val decoder = ZxingDecoder

    @SuppressLint("UnsafeOptimumUsageError")
    override fun analyze(image: ImageProxy) {
        try {
            // Use plane 0 (Y / luminance) for greyscale decoding.
            val plane = image.planes[0]
            val buffer: ByteBuffer = plane.buffer
            val rowStride = plane.rowStride
            val width = image.width
            val height = image.height

            // Copy the Y plane into a byte array (may include row padding).
            val bytes = ByteArray(buffer.remaining())
            buffer.get(bytes)

            // Decode on this analysis thread. Returns null if no QR found.
            val payload = try {
                decoder.decodeY(bytes, width, height, rowStride)
            } catch (e: UnsatisfiedLinkError) {
                Log.e(TAG, "ZXing native lib not loaded", e)
                null
            } catch (e: Exception) {
                null
            }

            if (payload != null) {
                onFrame(payload)
            }
        } finally {
            // Always close the image to receive the next one.
            image.close()
        }
    }

    companion object {
        private const val TAG = "QrStreamAnalyzer"
    }
}
