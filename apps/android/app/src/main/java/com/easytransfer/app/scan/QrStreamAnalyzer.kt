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
            val planes = image.planes
            if (planes.isEmpty()) return
            val plane = planes[0]
            // Log the actual delivered resolution once (diagnostics for the
            // 1080p-vs-720p upgrade). CameraX picks the closest supported size
            // to the requested ResolutionStrategy, so this confirms what the
            // device actually hands us.
            if (!loggedActualResolution) {
                loggedActualResolution = true
                Log.i(TAG, "actual analysis stream: ${image.width}x${image.height}" +
                    " rs=${plane.rowStride} fps-target was set via Camera2Interop")
            }
            pool.submit(plane.buffer, image.width, image.height, plane.rowStride)
        } catch (e: Exception) {
            // Narrowed from Throwable: an OutOfMemoryError from a large frame
            // allocation should not be swallowed here (it leaves the JVM in a
            // degraded state and continuing to accept frames worsens it). Only
            // ordinary per-frame failures are non-fatal.
            Log.w(TAG, "frame submit failed", e)
        } finally {
            // Always close so CameraX can deliver the next frame.
            image.close()
        }
    }

    companion object {
        private const val TAG = "QrStreamAnalyzer"
        /** Set true after the first frame logs the real delivered resolution. */
        private var loggedActualResolution = false
    }
}
