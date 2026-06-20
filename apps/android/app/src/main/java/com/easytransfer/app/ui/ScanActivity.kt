package com.easytransfer.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CaptureRequest
import android.os.Bundle
import android.util.Log
import android.util.Range
import android.util.Size
import android.view.Surface
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.easytransfer.app.nativelib.NativeBridge
import com.easytransfer.app.scan.BundleParser
import com.easytransfer.app.scan.HighSpeedCaptureController
import com.easytransfer.app.scan.QrDecodePool
import com.easytransfer.app.scan.QrStreamAnalyzer
import com.easytransfer.app.scan.ReceiverSessionManager
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

// Design tokens
private val BgDark = Color(0xFF0F172A)
private val CardBg = Color(0xCC1E293B)
private val Accent = Color(0xFF3B82F6)
private val AccentLight = Color(0xFF60A5FA)
private val TextPrimary = Color(0xFFF1F5F9)
private val TextSecondary = Color(0xFF94A3B8)
private val Success = Color(0xFF22C55E)

class ScanActivity : ComponentActivity() {

    private var session = ReceiverSessionManager()
    private val cameraExecutor = Executors.newSingleThreadExecutor()
    /** Dedicated single-thread executor for the post-recovery heavy work
     *  (JNI assemble, CRC, disk writes, bundle unpacking) so it never blocks
     *  the main thread. The work runs under the decode pool's ingest lock. */
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private var cameraStarted = false

    /** Parallel QR decode pool (capture → queue → N workers → serialized ingest). */
    private var decodePool: QrDecodePool? = null
    // Decode-rate sampling (computed on the throttled UI snapshot).
    private var lastRateTimeMs = 0L
    private var lastDecodedCount = 0L
    private var decodePerSec = 0

    // Experimental high-speed (record → batch decode) mode.
    private var highSpeedEnabled = false
    /** Live UI flag: starts == highSpeedEnabled, flips to false to fall back to
     *  the normal CameraX pipeline if the high-speed path fails at runtime. */
    private val useHighSpeedMode = mutableStateOf(false)
    private var highSpeedController: HighSpeedCaptureController? = null
    private var highSpeedSurface: Surface? = null
    private val highSpeedRecording = mutableStateOf(false)

    // Reactive state observed by Compose
    private val uiState = mutableStateOf(UiState())

    data class UiState(
        val statusText: String = "正在初始化…",
        val progressPct: Int = 0,
        val receivedSymbols: Int = 0,
        val totalSymbols: Int = 0,
        val decodedBlocks: Int = 0,
        val totalBlocks: Int = 0,
        val lossPct: Int = 0,
        val framesSeen: Long = 0,
        val decodePerSec: Int = 0,
        val framesDropped: Long = 0,
        val fileName: String = "",
        val fileSize: Long = 0,
        val complete: Boolean = false,
        val jniReady: Boolean = false,
    )

    private val requestCameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else updateUi { it.copy(statusText = "需要相机权限") }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 高速录像模式（record → batch decode）已下线。实测得不偿失：
        //  1. H.264 all-intra 即使 120Mbps 仍引入块效应/振铃，破坏 QR 锐利
        //     黑白边缘，ZXing 解码率骤降（40-70% 帧解码失败）。
        //  2. 录像后批量解码引入 2-5 秒管线延迟，录制期间 0 进度反馈。
        //  3. Camera2 ConstrainedHighSpeedCaptureSession 禁用 ImageReader，
        //     无法"边录边解"，只能录像后批处理 → 上述延迟无法消除。
        // 理论 2-4× 帧率优势被压缩损耗 + 延迟完全侵蚀，且仅旗舰机可用。
        // 统一走 60fps 实时 + 多码管道（已验证、全设备可用、实时反馈）。
        // HighSpeedCaptureController 源码保留供参考，但入口已关闭。
        highSpeedEnabled = false
        useHighSpeedMode.value = false

        // JNI self-test
        val jniOk = try {
            val h = NativeBridge.receiverCreate(0L, 1L, 1, 100, 1024)
            NativeBridge.receiverDestroy(h)
            true
        } catch (e: Exception) {
            Log.e(TAG, "JNI self-test FAILED", e); false
        }
        updateUi { it.copy(jniReady = jniOk, statusText = if (jniOk) "就绪 — 对准二维码…" else "JNI 加载失败") }
        if (!jniOk) {
            setContent { ErrorScreen("原生库加载失败，请重新安装应用。") }
            return
        }

        setContent { ScanScreen() }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            requestCameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    @Composable
    private fun ScanScreen() {
        val state by uiState
        val highSpeed by useHighSpeedMode

        Box(modifier = Modifier.fillMaxSize().background(BgDark)) {
            // Camera preview (full screen). High-speed mode uses a raw SurfaceView
            // (Camera2 high-speed sessions can't target a CameraX PreviewView);
            // the normal path uses CameraX's PreviewView.
            if (highSpeed) {
                AndroidView(
                    factory = { ctx ->
                        android.view.SurfaceView(ctx).also { sv ->
                            sv.holder.addCallback(object : android.view.SurfaceHolder.Callback {
                                override fun surfaceCreated(holder: android.view.SurfaceHolder) {
                                    highSpeedSurface = holder.surface
                                }
                                override fun surfaceChanged(holder: android.view.SurfaceHolder, format: Int, width: Int, height: Int) {}
                                override fun surfaceDestroyed(holder: android.view.SurfaceHolder) {
                                    highSpeedSurface = null
                                }
                            })
                        }
                    },
                    modifier = Modifier.fillMaxSize()
                )
            } else {
                AndroidView(
                    factory = { ctx ->
                        PreviewView(ctx).also { pv ->
                            pv.scaleType = PreviewView.ScaleType.FILL_CENTER
                        }
                    },
                    modifier = Modifier.fillMaxSize(),
                    update = { pv -> bindCameraIfNeeded(pv) }
                )
            }

            Column(
                modifier = Modifier.fillMaxSize().padding(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(modifier = Modifier.height(40.dp))

                // Circular progress indicator
                CircularProgress(
                    progress = state.progressPct / 100f,
                    label = "${state.progressPct}%",
                    sublabel = if (state.fileName.isNotEmpty()) state.fileName else "等待扫描…"
                )

                Spacer(modifier = Modifier.weight(1f))

                // Bottom info card
                if (state.totalSymbols > 0) {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(16.dp),
                        colors = CardDefaults.cardColors(containerColor = CardBg)
                    ) {
                        Column(modifier = Modifier.padding(20.dp)) {
                            InfoRow("已识别符号", "${state.receivedSymbols} / ${state.totalSymbols}")
                            InfoRow("已解码块", "${state.decodedBlocks} / ${state.totalBlocks}")
                            InfoRow("丢帧率", "${state.lossPct}%")
                            InfoRow("已扫描帧", "${state.framesSeen}")
                            InfoRow("解码速率", "${state.decodePerSec} 符号/秒")
                            if (state.framesDropped > 0) {
                                InfoRow("采集丢弃", "${state.framesDropped}")
                            }
                            if (state.fileName.isNotEmpty()) {
                                InfoRow("文件名", state.fileName)
                            }
                            if (state.fileSize > 0) {
                                InfoRow("文件大小", formatSize(state.fileSize))
                            }
                            LinearProgressIndicator(
                                progress = { state.progressPct / 100f },
                                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                                color = Accent,
                                trackColor = Color(0xFF334155)
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(12.dp))
                }

                // Status text
                Text(
                    text = state.statusText,
                    color = if (state.complete) Success else TextPrimary,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(modifier = Modifier.height(16.dp))

                // Experimental high-speed record / stop-and-decode control.
                // 已下线：highSpeedEnabled 恒为 false，此分支永不渲染（dead
                // branch）。保留代码结构供未来参考，但 Compose 编译器会移除它。
                if (highSpeed) {
                    val recording by highSpeedRecording
                    Button(
                        onClick = { if (recording) stopHighSpeed() else startHighSpeed() },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (recording) Color(0xFFDC2626) else Accent
                        )
                    ) {
                        Text(if (recording) "停止并解码" else "开始高速录制", fontSize = 16.sp)
                    }
                    Spacer(modifier = Modifier.height(12.dp))
                }

                // Action buttons row
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly
                ) {
                    ActionButton(Icons.Default.Folder, "文件") {
                        startActivity(Intent(this@ScanActivity, FileListActivity::class.java))
                    }
                    ActionButton(Icons.Default.Settings, "设置") {
                        startActivity(Intent(this@ScanActivity, SettingsActivity::class.java))
                    }
                    if (state.totalSymbols > 0 || state.complete) {
                        ActionButton(Icons.Default.Refresh, "重扫") { resetSession() }
                    }
                }
                Spacer(modifier = Modifier.height(24.dp))
            }
        }
    }

    @Composable
    private fun CircularProgress(progress: Float, label: String, sublabel: String) {
        Box(contentAlignment = Alignment.Center) {
            Surface(
                shape = CircleShape,
                color = CardBg,
                modifier = Modifier.size(160.dp)
            ) {}
            // Progress ring
            androidx.compose.foundation.Canvas(modifier = Modifier.size(160.dp)) {
                val stroke = 8.dp.toPx()
                val diameter = size.minDimension - stroke
                val topLeft = androidx.compose.ui.geometry.Offset(
                    (size.width - diameter) / 2f,
                    (size.height - diameter) / 2f
                )
                val arc = androidx.compose.ui.geometry.Size(diameter, diameter)
                drawArc(
                    color = Color(0xFF334155),
                    startAngle = -90f, sweepAngle = 360f, useCenter = false,
                    topLeft = topLeft, size = arc,
                    style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke)
                )
                drawArc(
                    color = Accent,
                    startAngle = -90f, sweepAngle = 360f * progress, useCenter = false,
                    topLeft = topLeft, size = arc,
                    style = androidx.compose.ui.graphics.drawscope.Stroke(width = stroke)
                )
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(label, color = TextPrimary, fontSize = 32.sp, fontWeight = FontWeight.Bold)
                Text(
                    sublabel.take(20),
                    color = TextSecondary, fontSize = 12.sp,
                    maxLines = 1
                )
            }
        }
    }

    @Composable
    private fun InfoRow(label: String, value: String) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(label, color = TextSecondary, fontSize = 13.sp)
            Text(value, color = TextPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        }
    }

    @Composable
    private fun ActionButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            FilledTonalIconButton(onClick = onClick, modifier = Modifier.size(52.dp)) {
                Icon(icon, contentDescription = label, tint = Accent)
            }
            Text(label, color = TextSecondary, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
        }
    }

    @Composable
    private fun ErrorScreen(msg: String) {
        Box(
            modifier = Modifier.fillMaxSize().background(BgDark),
            contentAlignment = Alignment.Center
        ) {
            Text(msg, color = TextPrimary, textAlign = TextAlign.Center, modifier = Modifier.padding(32.dp))
        }
    }

    // ===== Camera + session logic =====

    private fun bindCameraIfNeeded(previewView: PreviewView) {
        if (cameraStarted) return
        cameraStarted = true
        startCameraWithView(previewView)
    }

    private fun startCamera() {
        // Will be triggered by AndroidView update once a PreviewView is available.
    }

    /** Lazily create + start the shared parallel decode pool. */
    private fun ensurePool(): QrDecodePool {
        var p = decodePool
        if (p == null) {
            // Multi-QR mode: when on, the pool decodes every code on screen per
            // frame (not just the first), so a sender tiling 4 codes yields ~4×
            // throughput. On by default (matches the sender default); read from the
            // same "easytransfer" prefs the Settings screen writes.
            val multiQr = getSharedPreferences("easytransfer", MODE_PRIVATE)
                .getBoolean("multi_qr_mode", true)
            p = QrDecodePool(
                onDecoded = { payload -> handleFrameAsync(payload) },
                multiMode = multiQr,
            ).also { it.start() }
            decodePool = p
        }
        return p
    }

    /** Experimental: begin a high-speed recording; decoded frames flow into the
     *  same pool/receiver as the normal path once decoding starts.
     *
     *  已下线（@Deprecated）：高速录像模式因 H.264 损耗 + 录像后批处理延迟得不偿失，
     *  入口已关闭（highSpeedEnabled 恒为 false，UI 永不调用此方法）。保留方法体供
     *  未来参考，但不应再被调用。统一走 startCameraWithView 的 60fps 实时管道。 */
    @Deprecated("高速录像模式已下线，统一走 60fps 实时 + 多码管道")
    private fun startHighSpeed() {
        val surface = highSpeedSurface
        if (surface == null || !surface.isValid) {
            updateUi { it.copy(statusText = "预览未就绪，请稍候再试…") }
            return
        }
        ensurePool()
        // Start a fresh receiver for this capture (coordinated with the pool).
        val reset = {
            session.destroy()
            session = ReceiverSessionManager()
            ingestStopped.set(false)
        }
        decodePool?.runExclusive(reset) ?: reset()
        completedHandled = false

        val controller = HighSpeedCaptureController(
            context = this,
            previewSurface = surface,
            onYFrame = { buf, w, h, rs -> decodePool?.submit(buf, w, h, rs) },
            onStatus = { msg -> runOnUiThread { updateUi { it.copy(statusText = msg) } } },
            onError = { msg ->
                runOnUiThread {
                    highSpeedRecording.value = false
                    // Fall back to the normal real-time CameraX pipeline: releasing
                    // the controller and flipping useHighSpeedMode recomposes the
                    // preview to the PreviewView, whose update→bindCameraIfNeeded
                    // starts the standard QrDecodePool scanning path.
                    highSpeedController?.release()
                    highSpeedController = null
                    highSpeedSurface = null
                    useHighSpeedMode.value = false
                    updateUi { it.copy(statusText = "高速模式失败，已回退普通模式：$msg") }
                }
            }
        )
        highSpeedController = controller
        highSpeedRecording.value = true
        controller.startRecording()
    }

    /** Experimental: stop recording and kick off background decode of the clip.
     *  已下线（@Deprecated），见 [startHighSpeed]。 */
    @Deprecated("高速录像模式已下线，统一走 60fps 实时 + 多码管道")
    private fun stopHighSpeed() {
        highSpeedRecording.value = false
        highSpeedController?.stopAndDecode()
    }

    @androidx.annotation.OptIn(androidx.camera.camera2.interop.ExperimentalCamera2Interop::class)
    private fun startCameraWithView(previewView: PreviewView) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            try {
                val cameraProvider = cameraProviderFuture.get()

                // Get/create the parallel decode pool. Each decoded payload is fed
                // to the native receiver via handleFrameAsync, serialized by the
                // pool's ingest lock so the non-thread-safe JNI handle is only ever
                // touched by one thread at a time.
                val pool = ensurePool()

                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }

                // Request a 1080p analysis stream for more px/module (critical for
                // the 2×2 multi-QR grid, where each code is only ~1/4 of the
                // screen). CLOSEST_HIGHER_THEN_LOWER lets CameraX pick whatever
                // the device's sensor actually supports: a 1080p-capable sensor
                // delivers 1920×1080, an older/limited one falls back to 720p or
                // 480p gracefully. The actual delivered size is logged once by
                // QrStreamAnalyzer so we can confirm per-device behavior.
                //
                // The 60fps pin (below) is the real throughput guardrail: if a
                // device can only sustain 1080p@30, the fixed-[60,60] bind throws
                // and we retry at [30,60] — which still yields a usable 30fps. We
                // accept that tradeoff rather than hard-capping at 720p, because
                // modern flagships (2024+) comfortably do 1080p@60 on the YUV
                // analysis stream, and the px/module gain materially improves
                // multi-code decode rate (the dominant factor for multi-QR).
                val resolutionSelector = ResolutionSelector.Builder()
                    .setResolutionStrategy(
                        ResolutionStrategy(
                            Size(1920, 1080),
                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
                        )
                    )
                    .build()

                fun buildAnalysis(fpsRange: Range<Int>): ImageAnalysis =
                    ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .setResolutionSelector(resolutionSelector)
                        .also { builder ->
                            // Pin the sensor frame-rate via Camera2Interop (CameraX
                            // 1.3.x has no public ImageAnalysis#setTargetFrameRate).
                            Camera2Interop.Extender(builder).setCaptureRequestOption(
                                CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE,
                                fpsRange
                            )
                        }
                        .build()
                        .also { it.setAnalyzer(cameraExecutor, QrStreamAnalyzer(pool)) }

                // Pin a steady 60fps so low-light AE can't trade frame rate for a
                // longer exposure (the on-screen QR is a bright emissive source, so
                // a fixed 60 is usually fine and reduces motion / rolling-shutter
                // smear). Some devices reject a fixed [60,60]; fall back to [30,60].
                cameraProvider.unbindAll()
                try {
                    cameraProvider.bindToLifecycle(
                        this, CameraSelector.DEFAULT_BACK_CAMERA, preview, buildAnalysis(Range(60, 60))
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "fixed 60fps bind failed; falling back to 30–60", e)
                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        this, CameraSelector.DEFAULT_BACK_CAMERA, preview, buildAnalysis(Range(30, 60))
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "Camera bind failed", e)
                updateUi { it.copy(statusText = "相机启动失败") }
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private var lastUiUpdate = 0L
    private var completedHandled = false
    /** Once recovery completes, stop feeding the native receiver so the
     *  main-thread assemble() (a `&` borrow) can't race a worker ingest (`&mut`). */
    private val ingestStopped = AtomicBoolean(false)

    /**
     * Pure-data snapshot produced on a decode-worker thread and handed to the
     * main thread. Keeping every JNI / JSON / RaptorQ step off the main thread is
     * what lets the receiver keep up with the camera — the heavy ingest chain
     * runs on the [QrDecodePool]'s serialized ingest path, and only the throttled
     * UI snapshot is posted to the main thread.
     */
    private data class FrameSnapshot(
        val progress: ReceiverSessionManager.Progress,
        val fileName: String,
        val fileSize: Long
    )

    /** Ingest-thread entry (serialized by the pool): heavy work here, post a snapshot. */
    private fun handleFrameAsync(payload: ByteArray) {
        // After completion, drop further frames: the main thread is (or will be)
        // calling assemble() on the receiver, which must not run concurrently
        // with another ingest. This runs under the pool's ingest lock, so the
        // check+ingest+stop sequence is atomic w.r.t. other workers.
        if (ingestStopped.get()) return
        // ingest() returns a lightweight status (no JSON) so the per-frame path
        // stays cheap; the full progress is fetched only on the throttled UI tick.
        val status = session.ingest(payload) ?: return

        // UI refresh throttle: ~7 Hz is plenty for a progress bar, and keeps the
        // main thread free. Always let the final "complete" frame through.
        val now = System.currentTimeMillis()
        if (now - lastUiUpdate < 150 && !status.complete) return
        lastUiUpdate = now

        // On the UI tick (or completion), pull the full progress snapshot. This
        // is the only place the JSON is parsed — not every frame.
        val progress = session.progress() ?: return

        // Read file metadata from session (JNI) — keep on this background thread.
        val fn = if (session.isInitialized) session.fileName() else ""
        val fs = if (session.isInitialized) session.fileSize() else 0L

        val snapshot = FrameSnapshot(progress, fn, fs)
        if (status.complete) {
            // Block any further ingest before the completion path (assemble +
            // file I/O + Activity start) runs on the main thread.
            ingestStopped.set(true)
            runOnUiThread { applySnapshot(snapshot, handleCompletion = true) }
        } else {
            runOnUiThread { applySnapshot(snapshot, handleCompletion = false) }
        }
    }

    /** Main-thread only: apply the precomputed snapshot to Compose state. */
    private fun applySnapshot(s: FrameSnapshot, handleCompletion: Boolean) {
        val progress = s.progress
        // Progress bar tracks *received (de-duplicated) symbols*, not decoded
        // symbols. RaptorQ decodes a whole source block at once when it has
        // collected enough independent symbols, so a "decoded fraction" bar sits
        // flat near 0% for a long time and then jumps in steps — it reads as
        // "stuck". The received-symbol count, by contrast, increments by one
        // for every new symbol the receiver accepts, so the bar climbs ~linearly
        // and matches what the user sees on screen. Fountain repair symbols can
        // push receivedSymbols above totalSymbols K, so clamp to 100.
        val pct = when {
            progress.complete -> 100
            progress.metaConfirmed || progress.totalSymbols > 0 -> {
                if (progress.totalSymbols > 0) {
                    (progress.receivedSymbols * 100 / progress.totalSymbols).coerceIn(0, 100)
                } else {
                    0
                }
            }
            // Cache mode: no confirmed total yet. Estimate from the first frame's
            // total_symbols (advisory only) and cap at 15% — the descriptor may
            // later reveal a larger total, so don't over-promise early.
            progress.receivedSymbols > 0 -> {
                val estimated = session.getEstimatedTotalSymbols()
                if (estimated > 0) {
                    (progress.receivedSymbols * 100 / estimated).coerceIn(0, 15)
                } else {
                    0
                }
            }
            else -> 0
        }
        val statusMsg = when {
            progress.complete -> "✓ 文件恢复完成"
            !progress.metaConfirmed && progress.receivedSymbols > 0 ->
                "⏳ 正在同步… 已缓存 ${progress.receivedSymbols} 符号 (~$pct%)"
            progress.totalSymbols == 0 -> "等待二维码…"
            progress.receivedSymbols > 0 && progress.decodedBlocks == 0 ->
                "接收中… ${progress.receivedSymbols}/${progress.totalSymbols} 符号 (等待解码)"
            else -> "恢复中… $pct%"
        }
        // Sample the parallel decode rate (~1 Hz) from the pool's counters.
        val pool = decodePool
        if (pool != null) {
            val nowMs = System.currentTimeMillis()
            val decoded = pool.decodedCount()
            if (lastRateTimeMs == 0L) {
                lastRateTimeMs = nowMs
                lastDecodedCount = decoded
            } else if (nowMs - lastRateTimeMs >= 1000) {
                decodePerSec = ((decoded - lastDecodedCount) * 1000 / (nowMs - lastRateTimeMs)).toInt()
                lastRateTimeMs = nowMs
                lastDecodedCount = decoded
            }
        }
        val droppedTotal = decodePool?.droppedCount() ?: 0L

        updateUi {
            it.copy(
                progressPct = pct,
                receivedSymbols = progress.receivedSymbols,
                totalSymbols = progress.totalSymbols,
                decodedBlocks = progress.decodedBlocks,
                totalBlocks = progress.totalBlocks,
                lossPct = (progress.lossRatio * 100).toInt(),
                framesSeen = progress.framesSeen,
                decodePerSec = decodePerSec,
                framesDropped = droppedTotal,
                fileName = s.fileName,
                fileSize = s.fileSize,
                statusText = statusMsg,
                complete = progress.complete
            )
        }

        if (handleCompletion && progress.complete && !completedHandled) {
            completedHandled = true
            // Move the heavy recovery work (JNI assemble, CRC over the full
            // payload, disk writes, bundle unpacking) off the main thread — it
            // previously ran here synchronously and ANR'd on multi-MB transfers.
            // ingestStopped (set on the completing worker) already guarantees no
            // further ingest touches the native session, and we wrap the JNI
            // access in runExclusive so it cannot race a straggler or destroy().
            val snapshotFileName = s.fileName
            ioExecutor.execute {
                // Run the recovery under the pool's ingest lock (it touches the
                // native session via assemble/crc32/fileSize), then post the
                // resulting Intent to the main thread. runExclusive returns Unit,
                // so capture the Intent in a holder.
                var intent: Intent? = null
                val work = {
                    intent = recoverAndStage(snapshotFileName)
                }
                decodePool?.runExclusive(work) ?: work()
                intent?.let { runOnUiThread { startActivity(it) } }
            }
        }
    }

    /**
     * Assemble the recovered bytes, verify CRC, and stage the file(s) to disk.
     * Returns the [Intent] to launch the detail/bundle screen, or null if there
     * was nothing to recover. Runs on a background thread under the decode pool's
     * ingest lock (so it can't race an in-flight ingest or a destroy()).
     */
    private fun recoverAndStage(displayName: String): Intent? {
        val fileBytes = session.assemble() ?: return null
        val originalSize = session.fileSize()
        // Truncate RaptorQ zero-padding back to the original size. originalSize
        // is a Long (up to 2^63); clamp to the bytes we actually recovered and
        // never let a bogus/large value overflow Int (the old `originalSize.toInt()`
        // would wrap for >2GB and throw IndexOutOfBounds in copyOfRange).
        val truncLen = when {
            originalSize > 0 && originalSize <= fileBytes.size -> originalSize.toInt()
            else -> fileBytes.size
        }
        val truncBytes = fileBytes.copyOfRange(0, truncLen)

        val expectedCrc = session.crc32()
        val crcKnown = session.crc32Known()
        val receivedCrc = crc32OfBytes(truncBytes)

        // Multi-file bundle → unpack and route to the bundle detail screen.
        if (BundleParser.isBundle(truncBytes)) {
            val bundle = BundleParser.parse(truncBytes)
            if (bundle != null && bundle.files.isNotEmpty()) {
                val paths = ArrayList<String>()
                val names = ArrayList<String>()
                val sizes = ArrayList<String>()
                for (f in bundle.files) {
                    val safeName = com.easytransfer.app.scan.FileNameUtil.sanitize(f.name)
                    val tmp = java.io.File(cacheDir, "recovered_$safeName")
                    tmp.writeBytes(f.data)
                    paths.add(tmp.absolutePath)
                    names.add(f.name)
                    sizes.add(f.data.size.toString())
                }
                copyBundleToReceivedDir(paths, names, sizes)
                return Intent(this, ReceiveBundleActivity::class.java).apply {
                    putStringArrayListExtra("FILE_PATHS", paths)
                    putStringArrayListExtra("FILE_NAMES", names)
                    putStringArrayListExtra("FILE_SIZES", sizes)
                    putExtra("CRC32", expectedCrc)
                    putExtra("CRC32_RECEIVED", receivedCrc)
                    // Use the authoritative known-flag, NOT `expectedCrc == 0L`:
                    // CRC32 can legitimately be 0.
                    putExtra("CRC32_UNKNOWN", !crcKnown)
                }
            }
            // If parsing failed, fall through and treat as a single file so the
            // user still gets something rather than a dead end.
        }

        // Single-file path. Preserve the original name + extension in the temp
        // file (was recovered_<ts>.bin, which dropped the extension).
        val finalName = if (displayName.isNotEmpty()) displayName else "received_file"
        val safeName = com.easytransfer.app.scan.FileNameUtil.sanitize(finalName)
        val tmp = java.io.File(cacheDir, "recovered_$safeName")
        tmp.writeBytes(truncBytes)
        return Intent(this, ReceiveDetailActivity::class.java).apply {
            putExtra("FILE_PATH", tmp.absolutePath)
            putExtra("FILE_SIZE", if (originalSize > 0) originalSize else truncBytes.size.toLong())
            putExtra("FILE_NAME", finalName)
            putExtra("CRC32", expectedCrc)
            putExtra("CRC32_RECEIVED", receivedCrc)
            putExtra("CRC32_UNKNOWN", !crcKnown)
        }
    }

    /** Persist every unpacked bundle file to the received dir + write sidecars. */
    private fun copyBundleToReceivedDir(paths: List<String>, names: List<String>, sizes: List<String>) {
        try {
            val dir = java.io.File(getExternalFilesDir(null), "received")
            if (!dir.exists()) dir.mkdirs()
            for (i in paths.indices) {
                val src = java.io.File(paths[i])
                if (!src.exists()) continue
                // No timestamp prefix: dedupe with (1)(2) so the on-disk name
                // matches the original the user sent.
                val name = names.getOrElse(i) { src.name }
                val target = com.easytransfer.app.scan.FileNameUtil.uniqueTarget(dir, name)
                src.copyTo(target, overwrite = true)
                val size = sizes.getOrElse(i) { "0" }
                java.io.File(dir, "${target.name}.meta").writeText("$name\n$size\nunknown\ntrue")
            }
        } catch (_: Exception) {}
    }

    private fun resetSession() {
        // Swap the receiver under the pool's ingest lock so no worker is mid-ingest
        // while we destroy the old native handle.
        val swap = {
            session.destroy()
            session = ReceiverSessionManager()
            ingestStopped.set(false)
        }
        decodePool?.runExclusive(swap) ?: swap()
        completedHandled = false
        lastUiUpdate = 0
        lastRateTimeMs = 0
        lastDecodedCount = 0
        decodePerSec = 0
        updateUi {
            UiState(jniReady = true, statusText = "就绪 — 对准二维码…")
        }
    }

    private fun updateUi(block: (UiState) -> UiState) {
        uiState.value = block(uiState.value)
    }

    override fun onResume() {
        super.onResume()
        // If returning from ReceiveDetailActivity after completion, reset for next scan.
        if (completedHandled) {
            val swap = {
                session.destroy()
                session = ReceiverSessionManager()
                ingestStopped.set(false)
            }
            decodePool?.runExclusive(swap) ?: swap()
            completedHandled = false
            lastUiUpdate = 0
            lastRateTimeMs = 0
            lastDecodedCount = 0
            decodePerSec = 0
            updateUi { UiState(jniReady = true, statusText = "就绪 — 对准二维码…") }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
        // Stop the high-speed controller (if any) first so it stops feeding frames.
        highSpeedController?.release()
        highSpeedController = null
        // Drain the IO executor BEFORE tearing down the decode pool: the pending
        // recovery task holds the pool's ingest lock and touches the native
        // session, so freeing the handle first would race it. Shutdown + await
        // lets an in-flight stage finish (bounded; assemble is the slow part and
        // already running under ingestStopped, which halted further ingest).
        ioExecutor.shutdown()
        try {
            ioExecutor.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        // Stop workers, then destroy the native receiver UNDER the ingest lock so a
        // straggler that outran shutdown()'s join timeout can't still be mid-ingest
        // (&mut) when destroy() frees the handle (use-after-free).
        val pool = decodePool
        decodePool = null
        if (pool != null) {
            pool.shutdown()
            pool.runExclusive { session.destroy() }
        } else {
            session.destroy()
        }
    }

    companion object {
        private const val TAG = "ScanActivity"

        fun formatSize(bytes: Long): String {
            if (bytes < 1024) return "$bytes B"
            if (bytes < 1024 * 1024) return "%.1f KB".format(bytes / 1024.0)
            return "%.1f MB".format(bytes / 1024.0 / 1024.0)
        }

        fun crc32OfBytes(data: ByteArray): Long {
            // Compute CRC32 and return as an unsigned 32-bit value in a Long
            // (0..=0xFFFFFFFF) so it compares correctly with the JNI-supplied
            // expected CRC (also a Long). Using Int would sign-flip high-bit
            // values and break equality.
            var crc = 0xFFFFFFFF.toInt()
            for (b in data) {
                crc = crc xor (b.toInt() and 0xFF)
                repeat(8) {
                    crc = if (crc and 1 != 0) (crc ushr 1) xor 0xEDB88320.toInt() else crc ushr 1
                }
            }
            return (crc xor 0xFFFFFFFF.toInt()).toLong() and 0xFFFFFFFFL
        }
    }
}
