package com.easytransfer.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
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
                    .build()
                    .also {
                        it.setAnalyzer(cameraExecutor, QrStreamAnalyzer(this) { payload ->
                            runOnUiThread { handleFrame(payload) }
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

    private fun handleFrame(payload: ByteArray) {
        val progress = session.ingest(payload) ?: return

        // Read file metadata from session
        val fn = if (session.isInitialized) session.fileName() else ""
        val fs = if (session.isInitialized) session.fileSize() else 0L

        val now = System.currentTimeMillis()
        if (now - lastUiUpdate < 150 && !progress.complete) return
        lastUiUpdate = now

        val pct = (progress.decodedFraction * 100).toInt().coerceIn(0, 100)
        val statusMsg = when {
            progress.complete -> "✓ 文件恢复完成"
            progress.totalSymbols == 0 && progress.receivedSymbols > 0 -> "正在同步… 已缓存 ${progress.receivedSymbols} 帧"
            progress.totalSymbols == 0 -> "等待二维码…"
            progress.receivedSymbols > 0 && progress.decodedBlocks == 0 -> "接收中… ${progress.receivedSymbols}/${progress.totalSymbols} 符号 (等待解码)"
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
                fileName = fn,
                fileSize = fs,
                statusText = statusMsg,
                complete = progress.complete
            )
        }

        if (progress.complete && !completedHandled) {
            completedHandled = true
            val fileBytes = session.assemble()
            if (fileBytes != null) {
                // Truncate to original file size (strip symbol padding).
                val originalSize = session.fileSize()
                val truncLen = if (originalSize > 0 && originalSize <= fileBytes.size) originalSize.toInt() else fileBytes.size
                val truncBytes = fileBytes.copyOfRange(0, truncLen)
                val tmp = java.io.File(cacheDir, "recovered_${System.currentTimeMillis()}.bin")
                tmp.writeBytes(truncBytes)
                val intent = Intent(this, ReceiveDetailActivity::class.java).apply {
                    putExtra("FILE_PATH", tmp.absolutePath)
                    putExtra("FILE_SIZE", if (originalSize > 0) originalSize else truncBytes.size.toLong())
                    putExtra("FILE_NAME", if (fn.isNotEmpty()) fn else "received_file")
                    putExtra("CRC32", session.crc32())
                    // CRC32 computed over the truncated (original-size) bytes.
                    putExtra("CRC32_RECEIVED", crc32OfBytes(truncBytes))
                }
                startActivity(intent)
            }
        }
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

        fun crc32OfBytes(data: ByteArray): Int {
            var crc = 0xFFFFFFFF.toInt()
            for (b in data) {
                crc = crc xor (b.toInt() and 0xFF)
                repeat(8) {
                    crc = if (crc and 1 != 0) (crc ushr 1) xor 0xEDB88320.toInt() else crc ushr 1
                }
            }
            return crc xor 0xFFFFFFFF.toInt()
        }
    }
}
