package com.easytransfer.app.scan

import android.util.Log
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy

/**
 * CameraX [ImageAnalysis.Analyzer] that runs as a lightweight *producer*: it
 * copies the Y (luminance) plane of each frame into the [QrDecodePool] and
 * returns immediately, so the camera pipeline is never blocked by QR decoding.
 *
 * The actual ZXing decode runs in parallel on the pool's worker threads. This
 * replaces the previous design that decoded synchronously on the single analysis
 * thread — which couldn't keep up at high fps and dropped most frames.
 */
class QrStreamAnalyzer(
    private val pool: QrDecodePool
) : ImageAnalysis.Analyzer {

    override fun analyze(image: ImageProxy) {
        try {
            // Plane 0 is Y / luminance. Copy it into the pool (which reads the
            // buffer now) before we close the ImageProxy below.
            val plane = image.planes[0]
            pool.submit(plane.buffer, image.width, image.height, plane.rowStride)
        } catch (e: Throwable) {
            Log.w(TAG, "frame submit failed", e)
        } finally {
            // Always close so CameraX can deliver the next frame.
            image.close()
        }
    }

    companion object {
        private const val TAG = "QrStreamAnalyzer"
    }
}
