package com.easytransfer.app.scan

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraConstrainedHighSpeedCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.util.Range
import android.util.Size
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * EXPERIMENTAL: high-frame-rate "record → batch decode" capture (flagship only).
 *
 * Android's [CameraConstrainedHighSpeedCaptureSession] can only feed a preview
 * Surface and/or a video-encoder Surface — never an ImageReader for per-frame
 * CPU access. So the only way to exploit 120/240fps is to record, then decode the
 * recording afterward. To give dense QR codes a fighting chance through a lossy
 * codec, the encoder is configured **all-intra** (`KEY_I_FRAME_INTERVAL = 0`) at
 * a very high bitrate (no inter-frame prediction artifacts; only per-frame
 * quantization remains). Even so, expect a meaningful fraction of frames to fail
 * to decode — RaptorQ tolerates that, it just needs K distinct symbols.
 *
 * This whole path is gated behind [isSupported] and an opt-in setting; any
 * failure should fall back to the normal real-time [QrDecodePool] pipeline.
 *
 * Lifecycle: [startRecording] → (a few seconds) → [stopAndDecode]. Decoded Y
 * planes are handed to [onYFrame] (route them to a [QrDecodePool]); [onStatus]
 * reports progress; [onError] reports a fatal failure (caller should fall back).
 */
class HighSpeedCaptureController(
    private val context: Context,
    private val previewSurface: Surface,
    private val onYFrame: (ByteBuffer, Int, Int, Int) -> Unit,
    private val onStatus: (String) -> Unit,
    private val onError: (String) -> Unit
) {
    private val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private var cameraDevice: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var encoder: MediaCodec? = null
    private var encoderSurface: Surface? = null
    private var muxer: MediaMuxer? = null
    private var muxerTrack = -1
    private var muxerStarted = false
    private val recording = AtomicBoolean(false)
    private val decoding = AtomicBoolean(false)

    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    /** Separate thread for ImageReader callbacks during decode (must NOT be the
     *  same thread that runs the synchronous decode loop, or the loop starves the
     *  callback and the decoder's output surface saturates → stall). */
    private var readerThread: HandlerThread? = null
    private var readerHandler: Handler? = null
    /** Counted down when the encoder emits its end-of-stream output buffer. */
    private var encoderEosLatch: CountDownLatch? = null

    private var outputFile: File? = null
    private var captureSize: Size = Size(1280, 720)
    private var captureFps: Int = 120

    /** Start the camera, build a high-speed session, and begin recording. */
    fun startRecording() {
        val cameraId = highSpeedCameraId()
        if (cameraId == null) {
            onError("此设备不支持高速摄像")
            return
        }
        val chars = cameraManager.getCameraCharacteristics(cameraId)
        val (size, fps) = pickHighSpeedConfig(chars) ?: run {
            onError("无可用高速分辨率")
            return
        }
        captureSize = size
        captureFps = fps

        thread = HandlerThread("highspeed-cam").also { it.start() }
        handler = Handler(thread!!.looper)

        try {
            setupEncoderAndMuxer(size, fps)
        } catch (e: Exception) {
            Log.e(TAG, "encoder setup failed", e)
            onError("编码器初始化失败")
            release()
            return
        }

        try {
            openCamera(cameraId)
        } catch (e: SecurityException) {
            onError("缺少相机权限")
            release()
        } catch (e: Exception) {
            Log.e(TAG, "openCamera failed", e)
            onError("打开相机失败")
            release()
        }
    }

    /** Stop recording and decode the captured file, feeding frames to [onYFrame]. */
    fun stopAndDecode() {
        if (!recording.getAndSet(false)) return
        onStatus("正在结束录制…")
        try {
            session?.stopRepeating()
        } catch (_: Exception) {}
        // Finish + decode on a DEDICATED thread: not the camera `handler` (whose
        // async encoder callbacks must keep draining output, incl. the EOS buffer
        // the finish step waits on), and not the ImageReader `readerHandler`
        // (which delivers decoded frames while this loop runs).
        Thread({
            finishEncoding()
            val f = outputFile
            if (f == null || !f.exists() || f.length() == 0L) {
                onError("录制文件为空")
                release()
                return@Thread
            }
            decodeRecorded(f)
            release()
        }, "highspeed-finish").start()
    }

    // ---- camera + session ----

    private fun openCamera(cameraId: String) {
        @Suppress("MissingPermission")
        cameraManager.openCamera(cameraId, object : CameraDevice.StateCallback() {
            override fun onOpened(device: CameraDevice) {
                cameraDevice = device
                createHighSpeedSession(device)
            }
            override fun onDisconnected(device: CameraDevice) {
                device.close(); cameraDevice = null
            }
            override fun onError(device: CameraDevice, error: Int) {
                device.close(); cameraDevice = null
                onError("相机错误: $error")
            }
        }, handler)
    }

    @Suppress("DEPRECATION") // createConstrainedHighSpeedCaptureSession: simplest path for minSdk 29
    private fun createHighSpeedSession(device: CameraDevice) {
        val encSurface = encoderSurface ?: run { onError("编码器表面缺失"); return }
        val targets = listOf(previewSurface, encSurface)
        try {
            device.createConstrainedHighSpeedCaptureSession(targets, object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(configured: CameraCaptureSession) {
                    session = configured
                    startRepeatingBurst(device, configured, targets)
                }
                override fun onConfigureFailed(s: CameraCaptureSession) {
                    onError("高速会话配置失败")
                }
            }, handler)
        } catch (e: Exception) {
            Log.e(TAG, "createConstrainedHighSpeedCaptureSession failed", e)
            onError("无法创建高速会话")
        }
    }

    private fun startRepeatingBurst(device: CameraDevice, s: CameraCaptureSession, targets: List<Surface>) {
        try {
            val builder = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                targets.forEach { addTarget(it) }
                set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, Range(captureFps, captureFps))
            }
            val hsSession = s as CameraConstrainedHighSpeedCaptureSession
            val burst = hsSession.createHighSpeedRequestList(builder.build())
            encoder?.start()
            hsSession.setRepeatingBurst(burst, null, handler)
            recording.set(true)
            onStatus("高速录制中 ${captureFps}fps · ${captureSize.width}×${captureSize.height}")
        } catch (e: Exception) {
            Log.e(TAG, "startRepeatingBurst failed", e)
            onError("启动高速录制失败")
        }
    }

    // ---- encoder + muxer (all-intra H.264) ----

    private fun setupEncoderAndMuxer(size: Size, fps: Int) {
        val file = File(context.cacheDir, "highspeed_capture.mp4")
        if (file.exists()) file.delete()
        outputFile = file
        encoderEosLatch = CountDownLatch(1)

        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, size.width, size.height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_FRAME_RATE, fps)
            // All-intra: every frame is a keyframe → no inter-frame prediction
            // artifacts, the dominant QR killer. Costs ~2-4× bitrate.
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 0)
            // Very high bitrate to stay near-lossless on dense black/white edges.
            setInteger(MediaFormat.KEY_BIT_RATE, BITRATE)
        }
        val enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        enc.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        encoderSurface = enc.createInputSurface()
        enc.setCallback(object : MediaCodec.Callback() {
            override fun onInputBufferAvailable(codec: MediaCodec, index: Int) { /* surface input */ }
            override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
                drainEncoderOutput(codec, index, info)
            }
            override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
                Log.e(TAG, "encoder error", e)
            }
            override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
                val mx = muxer ?: return
                if (!muxerStarted) {
                    muxerTrack = mx.addTrack(format)
                    mx.start()
                    muxerStarted = true
                }
            }
        }, handler)
        encoder = enc
        muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    }

    private fun drainEncoderOutput(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
        try {
            if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                codec.releaseOutputBuffer(index, false)
                return
            }
            val buf = codec.getOutputBuffer(index)
            if (buf != null && info.size > 0 && muxerStarted) {
                buf.position(info.offset)
                buf.limit(info.offset + info.size)
                muxer?.writeSampleData(muxerTrack, buf, info)
            }
            codec.releaseOutputBuffer(index, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                encoderEosLatch?.countDown()
            }
        } catch (e: Exception) {
            Log.w(TAG, "drainEncoderOutput", e)
            // Don't strand the finisher if writing the EOS buffer threw.
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                encoderEosLatch?.countDown()
            }
        }
    }

    private fun finishEncoding() {
        try {
            encoder?.signalEndOfInputStream()
        } catch (_: Exception) {}
        // Wait for the encoder's EOS output buffer, drained on the camera `handler`
        // thread. We are on the dedicated finish thread, so this await does NOT
        // block the callback that counts the latch down.
        try {
            encoderEosLatch?.await(3, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {}
        try { encoder?.stop() } catch (_: Exception) {}
        try {
            if (muxerStarted) muxer?.stop()
        } catch (_: Exception) {}
    }

    // ---- decode phase: MediaExtractor + MediaCodec decoder → ImageReader ----

    private fun decodeRecorded(file: File) {
        if (decoding.getAndSet(true)) return
        onStatus("正在后台解码录像…")
        val extractor = MediaExtractor()
        var decoder: MediaCodec? = null
        var reader: ImageReader? = null
        // Dedicated thread for ImageReader callbacks — MUST differ from this
        // (decode-loop) thread, or the loop starves the callback and the decoder
        // output surface saturates (the C1 stall).
        val rThread = HandlerThread("highspeed-reader").also { it.start() }
        val rHandler = Handler(rThread.looper)
        readerThread = rThread
        readerHandler = rHandler
        try {
            extractor.setDataSource(file.absolutePath)
            val trackIndex = (0 until extractor.trackCount).firstOrNull {
                extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
            } ?: run { onError("录像无视频轨"); return }
            extractor.selectTrack(trackIndex)
            val inFormat = extractor.getTrackFormat(trackIndex)
            val w = inFormat.getInteger(MediaFormat.KEY_WIDTH)
            val h = inFormat.getInteger(MediaFormat.KEY_HEIGHT)

            reader = ImageReader.newInstance(w, h, ImageFormat.YUV_420_888, READER_BUFFERS)
            reader.setOnImageAvailableListener({ r ->
                val img = try { r.acquireNextImage() } catch (e: Exception) { null }
                if (img != null) {
                    try {
                        val plane = img.planes[0]
                        onYFrame(plane.buffer, img.width, img.height, plane.rowStride)
                    } catch (e: Exception) {
                        Log.w(TAG, "onYFrame", e)
                    } finally {
                        img.close()
                    }
                }
            }, rHandler)

            decoder = MediaCodec.createDecoderByType(
                inFormat.getString(MediaFormat.KEY_MIME) ?: MediaFormat.MIMETYPE_VIDEO_AVC
            )
            decoder.configure(inFormat, reader.surface, null, 0)
            decoder.start()

            drainDecodeLoop(extractor, decoder)
            // Let the last few async ImageReader callbacks drain before teardown.
            try { Thread.sleep(150) } catch (_: InterruptedException) {}
            onStatus("解码完成")
        } catch (e: Exception) {
            Log.e(TAG, "decodeRecorded failed", e)
            onError("解码录像失败")
        } finally {
            try { decoder?.stop() } catch (_: Exception) {}
            try { decoder?.release() } catch (_: Exception) {}
            try { extractor.release() } catch (_: Exception) {}
            try { reader?.close() } catch (_: Exception) {}
            try { file.delete() } catch (_: Exception) {}
            decoding.set(false)
        }
    }

    /** Synchronous decode loop: feed encoded samples, render decoded frames to the
     *  ImageReader surface (which triggers onYFrame). */
    private fun drainDecodeLoop(extractor: MediaExtractor, decoder: MediaCodec) {
        val info = MediaCodec.BufferInfo()
        var sawInputEos = false
        var sawOutputEos = false
        val timeoutUs = 10_000L
        while (!sawOutputEos) {
            if (!sawInputEos) {
                val inIndex = decoder.dequeueInputBuffer(timeoutUs)
                if (inIndex >= 0) {
                    val inBuf = decoder.getInputBuffer(inIndex)
                    val sampleSize = if (inBuf != null) extractor.readSampleData(inBuf, 0) else -1
                    if (sampleSize < 0) {
                        decoder.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        sawInputEos = true
                    } else {
                        decoder.queueInputBuffer(inIndex, 0, sampleSize, extractor.sampleTime, 0)
                        extractor.advance()
                    }
                }
            }
            val outIndex = decoder.dequeueOutputBuffer(info, timeoutUs)
            if (outIndex >= 0) {
                // render = true → frame goes to the ImageReader surface → onYFrame.
                decoder.releaseOutputBuffer(outIndex, true)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEos = true
            }
        }
    }

    fun release() {
        recording.set(false)
        try { session?.close() } catch (_: Exception) {}
        session = null
        try { cameraDevice?.close() } catch (_: Exception) {}
        cameraDevice = null
        try { encoder?.release() } catch (_: Exception) {}
        encoder = null
        try { encoderSurface?.release() } catch (_: Exception) {}
        encoderSurface = null
        try { muxer?.release() } catch (_: Exception) {}
        muxer = null
        muxerStarted = false
        muxerTrack = -1
        thread?.quitSafely()
        thread = null
        handler = null
        readerThread?.quitSafely()
        readerThread = null
        readerHandler = null
    }

    // ---- capability detection ----

    private fun highSpeedCameraId(): String? {
        return try {
            cameraManager.cameraIdList.firstOrNull { id ->
                val c = cameraManager.getCameraCharacteristics(id)
                val facing = c.get(CameraCharacteristics.LENS_FACING)
                val caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)
                facing == CameraCharacteristics.LENS_FACING_BACK &&
                    caps?.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_CONSTRAINED_HIGH_SPEED_VIDEO) == true
            }
        } catch (e: Exception) {
            null
        }
    }

    /** Pick the largest high-speed size ≤ 1280×720 and its highest fps (≥120). */
    private fun pickHighSpeedConfig(chars: CameraCharacteristics): Pair<Size, Int>? {
        val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return null
        val sizes = map.highSpeedVideoSizes ?: return null
        if (sizes.isEmpty()) return null
        // Prefer 1280×720 if available, else the largest size not exceeding it.
        val target = sizes.filter { it.width <= 1280 && it.height <= 720 }
            .maxByOrNull { it.width.toLong() * it.height }
            ?: sizes.minByOrNull { it.width.toLong() * it.height }
            ?: return null
        val ranges = map.getHighSpeedVideoFpsRangesFor(target)
        val fps = ranges.maxOfOrNull { it.upper } ?: return null
        if (fps < 120) return null
        return target to fps
    }

    companion object {
        private const val TAG = "HighSpeedCapture"
        /** All-intra needs a high bitrate to preserve dense QR edges (~120 Mbps). */
        private const val BITRATE = 120_000_000
        private const val READER_BUFFERS = 6

        /** True if any back camera advertises constrained high-speed video. */
        fun isSupported(context: Context): Boolean {
            return try {
                val mgr = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
                mgr.cameraIdList.any { id ->
                    val c = mgr.getCameraCharacteristics(id)
                    val caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES)
                    caps?.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_CONSTRAINED_HIGH_SPEED_VIDEO) == true
                }
            } catch (e: Exception) {
                false
            }
        }
    }
}
