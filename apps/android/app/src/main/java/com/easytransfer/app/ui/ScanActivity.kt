package com.easytransfer.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CaptureRequest
import android.os.Bundle
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.easytransfer.app.nativelib.NativeBridge
import com.easytransfer.app.scan.BundleParser
import com.easytransfer.app.scan.QrStreamAnalyzer
import com.easytransfer.app.scan.ReceiverSessionManager
import java.util.concurrent.Executors

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
    private var cameraStarted = false

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
        val context = LocalContext.current

        Box(modifier = Modifier.fillMaxSize().background(BgDark)) {
            // Camera preview (full screen)
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
                            InfoRow("已识别符号", "${state.receivedSymbols} / ${state.totalSymbols}")
                            InfoRow("已解码块", "${state.decodedBlocks} / ${state.totalBlocks}")
                            InfoRow("丢帧率", "${state.lossPct}%")
                            InfoRow("已扫描帧", "${state.framesSeen}")
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

    @androidx.annotation.OptIn(androidx.camera.camera2.interop.ExperimentalCamera2Interop::class)
    private fun startCameraWithView(previewView: PreviewView) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            try {
                val cameraProvider = cameraProviderFuture.get()
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val analyzer = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    // Request a 720p analysis stream. The default ImageAnalysis
                    // resolution (~640×480) leaves too few camera pixels per QR
                    // module to decode reliably, so data frames were silently
                    // dropped and the receiver stuck at "恢复中 0%". 720p gives
                    // ~8 px/module for our 81×81 codes with margin to spare.
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(
                                ResolutionStrategy(
                                    Size(1280, 720),
                                    ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
                                )
                            )
                            .build()
                    )
                    .also { builder ->
                        // Request a high sensor frame rate so ImageAnalysis receives up
                        // to ~60 fps where the device supports it (2x throughput vs the
                        // ~30 fps default). CameraX 1.3.x has no public
                        // ImageAnalysis.Builder#setTargetFrameRate, so we set the Camera2
                        // CONTROL_AE_TARGET_FPS_RANGE via Camera2Interop instead. A
                        // variable range (30..60) is preferred over a fixed (60,60):
                        // devices that don't reach 60 fps fall back to 30 instead of
                        // failing to open the camera.
                        Camera2Interop.Extender(builder).setCaptureRequestOption(
                            CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE,
                            Range(30, 60)
                        )
                    }
                    .build()
                    .also {
                        it.setAnalyzer(cameraExecutor, QrStreamAnalyzer(this@ScanActivity) { payload ->
                            // Heavy work (ZXing decode already ran above): feed the
                            // frame to the native receiver here, ON THE ANALYSIS
                            // THREAD. This is a background executor, so the JNI call
                            // (RaptorQ ingest + JSON serialization) does NOT compete
                            // with Compose rendering on the main thread. Only the
                            // throttled UI snapshot is posted to the main thread.
                            handleFrameAsync(payload)
                        })
                    }
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analyzer
                )
            } catch (e: Exception) {
                Log.e(TAG, "Camera bind failed", e)
                updateUi { it.copy(statusText = "相机启动失败") }
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private var lastUiUpdate = 0L
    private var completedHandled = false

    /**
     * Pure-data snapshot produced on the analysis thread and handed to the main
     * thread. Keeping every JNI / JSON / RaptorQ step off the main thread is what
     * lets the receiver keep up at 60 fps — previously the whole ingest chain ran
     * under runOnUiThread and competed with Compose rendering, capping the
     * effective receive rate well below the camera frame rate.
     */
    private data class FrameSnapshot(
        val progress: ReceiverSessionManager.Progress,
        val fileName: String,
        val fileSize: Long
    )

    /** Analysis-thread entry: do all heavy work here, post only a snapshot over. */
    private fun handleFrameAsync(payload: ByteArray) {
        val progress = session.ingest(payload) ?: return

        // Read file metadata from session (JNI) — keep on this background thread.
        val fn = if (session.isInitialized) session.fileName() else ""
        val fs = if (session.isInitialized) session.fileSize() else 0L

        // UI refresh throttle: ~7 Hz is plenty for a progress bar, and keeps the
        // main thread free. Always let the final "complete" frame through.
        val now = System.currentTimeMillis()
        if (now - lastUiUpdate < 150 && !progress.complete) return
        lastUiUpdate = now

        val snapshot = FrameSnapshot(progress, fn, fs)
        if (progress.complete) {
            // Completion path involves file I/O + Activity start → must run on
            // the main thread. Handle UI update + completion together.
            runOnUiThread { applySnapshot(snapshot, handleCompletion = true) }
        } else {
            runOnUiThread { applySnapshot(snapshot, handleCompletion = false) }
        }
    }

    /** Main-thread only: apply the precomputed snapshot to Compose state. */
    private fun applySnapshot(s: FrameSnapshot, handleCompletion: Boolean) {
        val progress = s.progress
        val pct = when {
            // Normal mode: metadata confirmed, use decoded progress
            progress.metaConfirmed || progress.totalSymbols > 0 -> {
                (progress.decodedFraction * 100).toInt().coerceIn(0, 100)
            }
            // Cache mode: estimate approximate progress based on first frame total_symbols
            progress.receivedSymbols > 0 -> {
                val estimated = session.getEstimatedTotalSymbols()
                if (estimated > 0) {
                    // Cap at 15% to avoid over-optimism (descriptor may reveal larger total)
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
        updateUi {
            it.copy(
                progressPct = pct,
                receivedSymbols = progress.receivedSymbols,
                totalSymbols = progress.totalSymbols,
                decodedBlocks = progress.decodedBlocks,
                totalBlocks = progress.totalBlocks,
                lossPct = (progress.lossRatio * 100).toInt(),
                framesSeen = progress.framesSeen,
                fileName = s.fileName,
                fileSize = s.fileSize,
                statusText = statusMsg,
                complete = progress.complete
            )
        }

        if (handleCompletion && progress.complete && !completedHandled) {
            completedHandled = true
            val fileBytes = session.assemble()
            if (fileBytes != null) {
                // Truncate to original file size (strip symbol padding).
                val originalSize = session.fileSize()
                val truncLen = if (originalSize > 0 && originalSize <= fileBytes.size) originalSize.toInt() else fileBytes.size
                val truncBytes = fileBytes.copyOfRange(0, truncLen)
                handleRecoveredBytes(truncBytes, s.fileName, originalSize)
            }
        }
    }

    /**
     * Route the recovered bytes to either the single-file detail screen or, if
     * the payload is a multi-file bundle, the bundle screen. The bundle is
     * unpacked into per-file temp files so each can be saved / shared
     * individually. Both paths run on the main thread (caller guarantees it).
     */
    private fun handleRecoveredBytes(bytes: ByteArray, displayName: String, originalSize: Long) {
        val expectedCrc = session.crc32()
        val receivedCrc = crc32OfBytes(bytes)

        // Multi-file bundle → unpack and route to the bundle detail screen.
        if (BundleParser.isBundle(bytes)) {
            val bundle = BundleParser.parse(bytes)
            if (bundle != null && bundle.files.isNotEmpty()) {
                val paths = ArrayList<String>()
                val names = ArrayList<String>()
                val sizes = ArrayList<String>()
                for (f in bundle.files) {
                    val safeName = sanitizeFileName(f.name)
                    val tmp = java.io.File(cacheDir, "recovered_${System.currentTimeMillis()}_$safeName")
                    tmp.writeBytes(f.data)
                    paths.add(tmp.absolutePath)
                    names.add(f.name)
                    sizes.add(f.data.size.toString())
                }
                // Copy all files to the received dir for the file list.
                copyBundleToReceivedDir(paths, names, sizes)
                val intent = Intent(this, ReceiveBundleActivity::class.java).apply {
                    putStringArrayListExtra("FILE_PATHS", paths)
                    putStringArrayListExtra("FILE_NAMES", names)
                    putStringArrayListExtra("FILE_SIZES", sizes)
                    putExtra("CRC32", expectedCrc)
                    putExtra("CRC32_RECEIVED", receivedCrc)
                    putExtra("CRC32_UNKNOWN", expectedCrc == 0L)
                }
                startActivity(intent)
                return
            }
            // If parsing failed, fall through and treat as a single file so the
            // user still gets something rather than a dead end.
        }

        // Single-file path (unchanged behaviour).
        val tmp = java.io.File(cacheDir, "recovered_${System.currentTimeMillis()}.bin")
        tmp.writeBytes(bytes)
        val intent = Intent(this, ReceiveDetailActivity::class.java).apply {
            putExtra("FILE_PATH", tmp.absolutePath)
            putExtra("FILE_SIZE", if (originalSize > 0) originalSize else bytes.size.toLong())
            putExtra("FILE_NAME", if (displayName.isNotEmpty()) displayName else "received_file")
            putExtra("CRC32", expectedCrc)
            putExtra("CRC32_RECEIVED", receivedCrc)
            putExtra("CRC32_UNKNOWN", expectedCrc == 0L)
        }
        startActivity(intent)
    }

    /** Sanitize a filename for use on the local filesystem. */
    private fun sanitizeFileName(name: String): String {
        return name.takeLast(64).replace(Regex("[^a-zA-Z0-9._\\u4e00-\\u9fff-]"), "_")
    }

    /** Persist every unpacked bundle file to the received dir + write sidecars. */
    private fun copyBundleToReceivedDir(paths: List<String>, names: List<String>, sizes: List<String>) {
        try {
            val dir = java.io.File(getExternalFilesDir(null), "received")
            if (!dir.exists()) dir.mkdirs()
            for (i in paths.indices) {
                val src = java.io.File(paths[i])
                if (!src.exists()) continue
                val safeName = sanitizeFileName(names.getOrElse(i) { src.name })
                val target = java.io.File(dir, "${System.currentTimeMillis()}_$safeName")
                src.copyTo(target, overwrite = true)
                val name = names.getOrElse(i) { src.name }
                val size = sizes.getOrElse(i) { "0" }
                java.io.File(dir, "${target.name}.meta").writeText("$name\n$size\nunknown\ntrue")
            }
        } catch (_: Exception) {}
    }

    private fun resetSession() {
        session.destroy()
        session = ReceiverSessionManager()
        completedHandled = false
        lastUiUpdate = 0
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
            session.destroy()
            completedHandled = false
            lastUiUpdate = 0
            updateUi { UiState(jniReady = true, statusText = "就绪 — 对准二维码…") }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
        session.destroy()
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
