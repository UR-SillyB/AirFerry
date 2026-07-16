package com.airferry.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CaptureRequest
import android.os.Bundle
import android.widget.Toast
import android.util.Log
import android.util.Range
import android.util.Size
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
import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.airferry.app.nativelib.NativeBridge
import com.airferry.app.scan.BundleParser
import com.airferry.app.scan.QrDecodePool
import com.airferry.app.scan.QrStreamAnalyzer
import com.airferry.app.scan.ReceiverSessionManager
import com.airferry.app.scan.TextParser
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

// Design tokens
private val BgDark = Color(0xFF0F172A)
private val CardBg = Color(0xCC1E293B)
private val Accent = Color(0xFF3B82F6)
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
        /**         Snapshot of per-code activity timestamps for the code-status row. */
        val codeActivitySnapshot: Map<Int, Long> = emptyMap(),
        /** How many QR codes the decoder is tracking (0/1/4). */
        val multiCodeCount: Int = 0,
        /** Elapsed transfer time in ms (0 = not started yet). */
        val transferElapsedMs: Long = 0,
        /** RaptorQ symbol size in bytes (from the sender's config). */
        val symbolSize: Int = 0,
    )

    // ===== Per-code scan status (shown in the info card) =====
    //
    // For a multi-QR sender we show, in the bottom info card, whether each
    // on-screen code is actively delivering symbols. A code is mapped to a fixed
    // grid slot by [gridSlotOf] (single-code → center slot, multi-code → one of
    // four 2×2 slots). We record the last wall-clock ms each slot ACCEPTED a new
    // RaptorQ symbol; the UI compares that against now to label the code
    // "receiving" (within [CODE_ACTIVE_MS]) / "paused" (seen before but stale) /
    // "unseen" (multi-code slots that never fired). This replaces the old
    // positional spark overlay, which was hard to land accurately.

    /**
     * Map of grid slot → last-accepted-symbol wall-clock ms. Written on the
     * ingest worker under [codeActivityLock]; read + snapshot on the UI tick.
     */
    private val codeActivityLock = Any()
    private val codeActivity = HashMap<Int, Long>()
    /** Reactive snapshot of [codeActivity] consumed by Compose. */
    private val codeActivityState = mutableStateOf<Map<Int, Long>>(emptyMap())

    private val recoveryStage = mutableStateOf<String?>(null)
    /** Wall-clock ms when the transfer first started (totalSymbols > 0). */
    private var transferStartMs = 0L

    private val requestCameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else updateUi { it.copy(statusText = "需要相机权限") }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
        val recovery by recoveryStage

        BoxWithConstraints(modifier = Modifier.fillMaxSize().background(BgDark)) {

            // Camera preview (full screen) — CameraX PreviewView + ImageAnalysis.
            AndroidView(
                factory = { ctx ->
                    PreviewView(ctx).also { pv ->
                        pv.scaleType = PreviewView.ScaleType.FILL_CENTER
                    }
                },
                modifier = Modifier.fillMaxSize(),
                update = { pv -> bindCameraIfNeeded(pv) }
            )

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
                            // 文件标题行（大号字体，仅文件名）
                            if (state.fileName.isNotEmpty()) {
                                Text(
                                    state.fileName,
                                    color = TextPrimary,
                                    fontSize = 17.sp,
                                    fontWeight = FontWeight.Bold,
                                    maxLines = 1,
                                    modifier = Modifier.padding(bottom = 4.dp)
                                )
                            }
                            // 大小行（原大小~压缩后大小）
                            val wireTotal = state.totalSymbols.toLong() * state.symbolSize.coerceAtLeast(1)
                            val showOrig = state.fileSize > 0
                            val showWire = wireTotal > 0 && state.symbolSize > 0
                            if (showOrig || showWire) {
                                val sizeStr = buildString {
                                    if (showOrig) {
                                        append(formatSize(state.fileSize))
                                        if (showWire) append("~压缩后 ")
                                    }
                                    if (showWire) append(formatSize(wireTotal))
                                }
                                InfoRow("大小", sizeStr)
                            }
                            InfoRow("已识别符号", "${state.receivedSymbols} / ${state.totalSymbols}")
                            InfoRow("解码速率", "${state.decodePerSec} 符号/秒")
                            // 传输用时 + 实时速度（进度条上方）
                            if (state.transferElapsedMs > 0) {
                                val elapsedStr = formatDuration(state.transferElapsedMs)
                                // 传输速度 = 线上已收符号数据量 / 用时
                                // （符号数 × 符号大小 = 实际线上传输量，非原始文件大小）
                                val rxSymbols = state.receivedSymbols.coerceAtLeast(0)
                                val wireBytes = rxSymbols.toLong() * state.symbolSize.coerceAtLeast(1)
                                val speedBytesPerSec = if (state.transferElapsedMs > 0)
                                    (wireBytes * 1000 / state.transferElapsedMs).coerceAtLeast(0) else 0L
                                val speedStr = if (speedBytesPerSec > 0) formatSize(speedBytesPerSec) + "/s" else ""
                                InfoRow("用时", if (speedStr.isNotEmpty()) "$elapsedStr @ $speedStr" else elapsedStr)
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

                // Status text. A live recovery stage (assemble/CRC/save) takes
                // precedence over the "✓ 文件恢复完成" snapshot, so the user sees
                // the post-scan pipeline advancing instead of a frozen 100%.
                Text(
                    text = recovery ?: state.statusText,
                    color = if (recovery != null) Accent
                            else if (state.complete) Success else TextPrimary,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                )

                Spacer(modifier = Modifier.height(16.dp))

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

    // QrPositionOverlay (spark overlay) 已移除。
    // 改为在信息卡片中以文字标出每个码的扫描状态（活跃/暂停/未扫描）。

    @Composable
    private fun InfoRow(label: String, value: String) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)
        ) {
            Text(label, color = TextSecondary, fontSize = 13.sp)
            Text(
                value, color = TextPrimary, fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                softWrap = false,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f)
            )
        }
    }

    /** How long (ms) since the last decoded symbol before a code is considered "paused".
     *  5s gives a very stable display even on intermittent multi-code decode rates. */
    private val CODE_ACTIVE_MS = 5000L

    /**
     * Build a compact per-code status string for the info card.
     *
     * Each grid slot's last-activity timestamp is compared against [CODE_ACTIVE_MS]
     * to determine: "●" (active, within threshold), "○" (paused, seen but stale),
     * or "·" (unseen, never received a symbol).
     *
     * [multiCount] comes from the decode pool's tracker. ≤ 1 = single-code mode;
     * ≥ 2 = multi-code mode.  An important safety net: if the pool occasionally
     * reports count=1 while slot 0–3 have already received symbols, the function
     * forces multi-code mode — so the display never flips back to "单码" mid-transfer.
     */
    private fun codeStatusString(activity: Map<Int, Long>, multiCount: Int): String {
        if (activity.isEmpty()) return "等待扫描…"
        val now = System.currentTimeMillis()

        val codeActive = { slot: Int ->
            val last = activity[slot]
            when {
                last == null -> "·"           // unseen
                now - last < CODE_ACTIVE_MS -> "●"  // active
                else -> "○"                  // paused
            }
        }

        // Safety net: if any real grid slot (0–3) has activity, the decoder IS
        // tracking multiple codes. Never revert to single-code mode even if the
        // pool's snapshotMultiCount() temporarily dips to 1.
        val hasRealSlot = activity.keys.any { it >= 0 }
        val effectiveCount = if (hasRealSlot) {
            maxOf(multiCount, activity.keys.count { it >= 0 }).coerceIn(2, 4)
        } else {
            multiCount
        }

        // Single-code mode: only the center slot.
        if (effectiveCount <= 1) {
            val dot = codeActive(SLOT_CENTER)
            return if (dot == "·") "等待扫描…" else "$dot ${if (dot == "●") "活跃" else "暂停"}"
        }

        // Multi-code mode: always show all 4 slots (①②③④) so the display
        // length never changes regardless of how many codes the tracker sees.
        val labels = arrayOf("①", "②", "③", "④")
        val parts = List(4) { i -> "${labels[i]}${codeActive(i)}" }
        return parts.joinToString(" ")
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
            // Multi-QR mode is always on: the pool decodes every code on screen per
            // frame (not just the first), so a sender tiling N codes yields ~N×
            // throughput. Single-code senders decode just as well (the multi path
            // returns one result), so there's no need for a user-facing toggle — it
            // worked regardless of the switch position, and only added confusion.
            p = QrDecodePool(
                onDecoded = { payload, bbox -> handleFrameAsync(payload, bbox) },
                multiMode = true,
            ).also { it.start() }
            decodePool = p
        }
        return p
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

                // Request a 1080p analysis stream so each QR module has more camera pixels,
                // improving ZXing decode reliability — especially important with the
                // reduced quiet zone on multi-QR. CameraX may pick the closest
                // supported size.
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

    /** Ingest-thread entry (serialized by the pool): heavy work here, post a snapshot.
     *
     *  [bbox] is the decoded code's {minX,minY,maxX,maxY} in analysis-stream
     *  pixel coords (null on the legacy single-code path). When the receiver
     *  *accepts* the symbol as new (RaptorQ dedup passed), the code's activity
     *  timestamp is recorded for the per-code status indicator. */
    private fun handleFrameAsync(payload: ByteArray, bbox: IntArray?) {
        // After completion, drop further frames: the main thread is (or will be)
        // calling assemble() on the receiver, which must not run concurrently
        // with another ingest. This runs under the pool's ingest lock, so the
        // check+ingest+stop sequence is atomic w.r.t. other workers.
        if (ingestStopped.get()) return
        // ingest() returns a lightweight status (no JSON) so the per-frame path
        // stays cheap; the full progress is fetched only on the throttled UI tick.
        val status = session.ingest(payload) ?: return

        // Record this code's last-decoded timestamp (keyed by grid slot) so the
        // info card can show per-code status (active / paused / unseen).  We
        // track EVERY decoded frame, not just accepted symbols — once a block
        // is fully decoded, subsequent symbols are RaptorQ-duplicate-rejected
        // (not "accepted") but the code is still being actively scanned.
        if (bbox != null) {
            val pool = decodePool
            if (pool != null) {
                val slot = gridSlotOf(bbox, pool)
                synchronized(codeActivityLock) {
                    codeActivity[slot] = System.currentTimeMillis()
                }
            }
        }

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

        val snapshotMap = synchronized(codeActivityLock) { HashMap(codeActivity) }
        val mcCount = decodePool?.snapshotMultiCount() ?: 0

        // Start the transfer timer on first symbol receipt.
        if (progress.totalSymbols > 0 && transferStartMs == 0L) {
            transferStartMs = System.currentTimeMillis()
        }
        val elapsedMs = if (transferStartMs > 0) System.currentTimeMillis() - transferStartMs else 0L

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
                complete = progress.complete,
                codeActivitySnapshot = snapshotMap,
                multiCodeCount = mcCount,
                transferElapsedMs = elapsedMs,
                symbolSize = session.symbolSizeBytes()
            )
        }

        // Update codeActivityState for any Compose bindings that read it directly.
        codeActivityState.value = snapshotMap

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
        updateRecoveryStage("正在组装数据…")
        val fileBytes = session.assemble() ?: run {
            clearRecoveryStage()
            if (session.isComplete()) {
                val detail = session.lastAssembleError().ifEmpty { "数据组装或解压失败" }
                runOnUiThread {
                    Toast.makeText(this, "恢复失败: $detail", Toast.LENGTH_LONG).show()
                }
            }
            return null
        }
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

        updateRecoveryStage("正在校验完整性…")
        val expectedCrc = session.crc32()
        val crcKnown = session.crc32Known()
        val receivedCrc = crc32OfBytes(truncBytes)

        // Content-addressed store: one blob per unique content; detail/share/list
        // all use the blob path (no recovered_* + received/ double-write).
        val store = com.airferry.app.scan.ContentStore

        // Text payload → ETTEXTv1. Detected BEFORE the bundle check.
        if (TextParser.isText(truncBytes)) {
            val text = TextParser.parse(truncBytes)
            if (text != null) {
                updateRecoveryStage("正在保存文字…")
                val contentBytes = text.toByteArray(Charsets.UTF_8)
                val contentCrc = crc32OfBytes(contentBytes)
                val crcHex = java.lang.Long.toHexString(contentCrc)
                val put = store.putBytes(
                    this, TEXT_RECEIVED_NAME, contentBytes,
                    crcHex = crcHex, crcUnknown = false, kind = "text",
                )
                clearRecoveryStage()
                return Intent(this, ReceiveTextActivity::class.java).apply {
                    putExtra("TEXT", text)
                    putExtra("FILE_PATH", put.path.absolutePath)
                    putExtra("FILE_NAME", put.entry.name)
                    putExtra("ENTRY_ID", put.entry.id)
                    putExtra("CRC32", contentCrc)
                    putExtra("CRC32_RECEIVED", contentCrc)
                    putExtra("CRC32_UNKNOWN", false)
                }
            }
        }

        // Multi-file bundle → one ContentStore entry per member, shared bundleId.
        if (BundleParser.isBundle(truncBytes)) {
            val bundle = BundleParser.parse(truncBytes)
            if (bundle != null && bundle.files.isNotEmpty()) {
                val totalFiles = bundle.files.size
                val paths = ArrayList<String>()
                val names = ArrayList<String>()
                val sizes = ArrayList<String>()
                val entryIds = ArrayList<String>()
                val ts = java.text.SimpleDateFormat("MMdd_HHmmss", java.util.Locale.getDefault())
                    .format(java.util.Date())
                val bundleId = java.util.UUID.randomUUID().toString()
                val bundleTitle = "发送_$ts"
                for ((idx, f) in bundle.files.withIndex()) {
                    updateRecoveryStage("正在保存文件 (${idx + 1}/$totalFiles)…")
                    val put = store.putBytes(
                        this, f.name, f.data,
                        crcHex = "unknown", crcUnknown = true, kind = "file",
                        bundleId = bundleId, bundleTitle = bundleTitle,
                    )
                    paths.add(put.path.absolutePath)
                    names.add(f.name)
                    sizes.add(f.data.size.toString())
                    entryIds.add(put.entry.id)
                }
                clearRecoveryStage()
                return Intent(this, ReceiveBundleActivity::class.java).apply {
                    putStringArrayListExtra("FILE_PATHS", paths)
                    putStringArrayListExtra("FILE_NAMES", names)
                    putStringArrayListExtra("FILE_SIZES", sizes)
                    putStringArrayListExtra("ENTRY_IDS", entryIds)
                    putExtra("CRC32", expectedCrc)
                    putExtra("CRC32_RECEIVED", receivedCrc)
                    putExtra("CRC32_UNKNOWN", !crcKnown)
                }
            }
        }

        // Single-file path (or text-like). Canonical store path only.
        updateRecoveryStage("正在保存文件…")
        val finalName = if (displayName.isNotEmpty()) displayName else "received_file"
        val contentCrc = crc32OfBytes(truncBytes)
        val crcHex = if (crcKnown) java.lang.Long.toHexString(expectedCrc) else java.lang.Long.toHexString(contentCrc)
        val crcUnknown = !crcKnown

        if (com.airferry.app.scan.TextLike.isTextLikeName(finalName) &&
            com.airferry.app.scan.TextLike.fitsTextUi(truncBytes.size)
        ) {
            val text = com.airferry.app.scan.TextLike.decodeUtf8Strict(truncBytes)
            if (text != null) {
                val archiveLabel =
                    if (finalName.contains('.')) finalName else TEXT_RECEIVED_NAME
                val put = store.putBytes(
                    this, archiveLabel, truncBytes,
                    crcHex = java.lang.Long.toHexString(contentCrc),
                    crcUnknown = false,
                    kind = "text",
                )
                clearRecoveryStage()
                return Intent(this, ReceiveTextActivity::class.java).apply {
                    putExtra("TEXT", text)
                    putExtra("FILE_PATH", put.path.absolutePath)
                    putExtra("FILE_NAME", finalName)
                    putExtra("ENTRY_ID", put.entry.id)
                    putExtra("CRC32", if (crcKnown) expectedCrc else contentCrc)
                    putExtra("CRC32_RECEIVED", contentCrc)
                    putExtra("CRC32_UNKNOWN", !crcKnown)
                }
            }
        }

        val put = store.putBytes(
            this, finalName, truncBytes,
            crcHex = crcHex, crcUnknown = crcUnknown, kind = "file",
        )
        clearRecoveryStage()
        return Intent(this, ReceiveDetailActivity::class.java).apply {
            putExtra("FILE_PATH", put.path.absolutePath)
            putExtra("FILE_SIZE", if (originalSize > 0) originalSize else truncBytes.size.toLong())
            putExtra("FILE_NAME", finalName)
            putExtra("ENTRY_ID", put.entry.id)
            putExtra("CRC32", expectedCrc)
            putExtra("CRC32_RECEIVED", receivedCrc)
            putExtra("CRC32_UNKNOWN", !crcKnown)
            // Already archived into ContentStore — do not copy again.
            putExtra("RESAVE", true)
        }
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
        // Clear per-code activity state.
        synchronized(codeActivityLock) { codeActivity.clear() }
        codeActivityState.value = emptyMap()
        transferStartMs = 0L
        recoveryStage.value = null
        updateUi {
            UiState(jniReady = true, statusText = "就绪 — 对准二维码…")
        }
    }

    private fun updateUi(block: (UiState) -> UiState) {
        uiState.value = block(uiState.value)
    }

    /** Set the live recovery-stage status text (posted to the main thread).
     *  Called from [ioExecutor] during [recoverAndStage] so the user sees the
     *  post-scan pipeline advancing instead of a frozen "完成". */
    private fun updateRecoveryStage(text: String) {
        runOnUiThread { recoveryStage.value = text }
    }

    /** Clear the recovery-stage status (e.g. right before launching the result
     *  Activity, or on error / reset). */
    private fun clearRecoveryStage() {
        runOnUiThread { recoveryStage.value = null }
    }

    /**
     * Snap a decoded code's bbox to a grid slot for per-code status tracking.
     *
     * Returns:
     *  - [SLOT_CENTER] (-1) for a single on-screen code.
     *  - 0..3 for a multi-code grid (2×2): the code's bbox center decides which
     *    quadrant of the analysis frame it sits in.
     *
     * Quadrant → slot index (in normalized upright-image space):
     *   left/right = bbox center X vs frame mid; top/bottom = center Y vs mid.
     *   0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right.
     */
    private fun gridSlotOf(bbox: IntArray, pool: QrDecodePool): Int {
        val count = pool.snapshotMultiCount()
        // Single code (or tracker not yet locked) → center slot.
        if (count <= 1) return SLOT_CENTER
        val (aw, ah) = pool.snapshotAnalysisSize()
        if (aw <= 0 || ah <= 0) return SLOT_CENTER
        // Use the bbox CENTER (robust to perspective corner overshoot) relative
        // to the analysis-frame midpoint to pick a quadrant. We compare against
        // raw analysis coords (not the rotated mapping) because a 90° rotation
        // only swaps axes — the left/right + top/bottom partition of the frame
        // is preserved, which is all we need to pick a grid slot.
        val cxRaw = (bbox[0].toFloat() + bbox[2].toFloat()) * 0.5f
        val cyRaw = (bbox[1].toFloat() + bbox[3].toFloat()) * 0.5f
        val right = cxRaw > aw * 0.5f
        val bottom = cyRaw > ah * 0.5f
        return when {
            !right && !bottom -> 0   // top-left
            right && !bottom -> 1    // top-right
            !right && bottom -> 2    // bottom-left
            else -> 3                // bottom-right
        }
    }

    // slotScreenPos 已移除（火花动画已删除）。

    // refreshOverlay / dedupeSparksBySlot 已移除（火花动画已删除）。
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
            synchronized(codeActivityLock) { codeActivity.clear() }
            codeActivityState.value = emptyMap()
            transferStartMs = 0L
            recoveryStage.value = null
            updateUi { UiState(jniReady = true, statusText = "就绪 — 对准二维码…") }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
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
        /** Slot index for a single on-screen code (used by gridSlotOf). */
        private const val SLOT_CENTER = -1
        /**
         * Filename used when archiving a recovered TEXT transfer to received/.
         * uniqueTarget appends (1)/(2)… on collision so each text is a distinct
         * history entry. The `.txt` extension keeps it openable as plain text
         * by any app.
         */
        private const val TEXT_RECEIVED_NAME = "文字消息.txt"

        fun formatSize(bytes: Long): String {
            if (bytes < 1024) return "$bytes B"
            if (bytes < 1024 * 1024) return "%.1f KB".format(bytes / 1024.0)
            return "%.1f MB".format(bytes / 1024.0 / 1024.0)
        }

        /** Format milliseconds as a human-readable duration (e.g. "23 秒", "1 分 05 秒"). */
        fun formatDuration(ms: Long): String {
            val totalSec = ms / 1000
            if (totalSec < 60) return "${totalSec} 秒"
            val m = totalSec / 60
            val s = totalSec % 60
            return "${m} 分 ${s.toString().padStart(2, '0')} 秒"
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
