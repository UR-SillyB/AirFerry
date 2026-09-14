package com.airferry.app.ui

import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.lifecycleScope
import com.airferry.app.send.ChunkPlan
import com.airferry.app.send.QrBatch
import com.airferry.app.send.SendItem
import com.airferry.app.send.SenderSessionManager
import com.airferry.app.send.uniqueSendDisplayName
import com.airferry.app.send.validateSendItems
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.min
import kotlin.math.roundToInt

// Design tokens (same palette as ScanActivity)
private val BgDark = Color(0xFF0F172A)
private val CardBg = Color(0xCC1E293B)
private val Accent = Color(0xFF3B82F6)
private val TextPrimary = Color(0xFFF1F5F9)
private val TextSecondary = Color(0xFF94A3B8)
private val Success = Color(0xFF22C55E)

/** Speed presets (symbolSize + fps), mirroring the web sender's low/mid tiers —
 *  phone screens are small scan targets, so the dense tiers stay desktop-only. */
private data class SpeedPreset(val label: String, val symbolSize: Int, val fps: Int)
private val PRESETS = listOf(
    SpeedPreset("稳定", 512, 30),
    SpeedPreset("均衡", 896, 30),
    SpeedPreset("极速", 1400, 45)
)

private enum class Page { SELECT, PREPARE, PLAY }

private class SendUiState {
    var page by mutableStateOf(Page.SELECT)
    var items by mutableStateOf<List<SendItem>>(emptyList())
    var presetIndex by mutableStateOf(1) // 均衡
    var prepDone by mutableStateOf(0L)
    var prepTotal by mutableStateOf(1L)
    var frame by mutableStateOf<QrFrame?>(null)
    var statsText by mutableStateOf("")
    var errorText by mutableStateOf<String?>(null)
}

/** One rendered frame: module bitmap + monotonically increasing sequence so
 *  Compose recomposes even when two frames share dimensions. */
private class QrFrame(val bitmap: ImageBitmap, val side: Int, val seq: Long)

class SendActivity : ComponentActivity() {

    private lateinit var sender: SenderSessionManager
    private val ui = SendUiState()
    private var frameSeq = 0L

    private val pickFiles =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            if (uris.isNullOrEmpty()) return@registerForActivityResult
            val usedNames = ui.items.mapTo(mutableSetOf()) { item ->
                java.text.Normalizer.normalize(item.displayName, java.text.Normalizer.Form.NFC)
            }
            val resolved = uris.mapNotNull { uri ->
                resolveItem(uri)?.let { item ->
                    item.copy(displayName = uniqueSendDisplayName(usedNames, item.displayName))
                }
            }
            if (resolved.size < uris.size) {
                Toast.makeText(this, "部分文件无法读取大小，已跳过", Toast.LENGTH_LONG).show()
            }
            if (resolved.isNotEmpty()) {
                ui.items = ui.items + resolved
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sender = SenderSessionManager(contentResolver)
        setContent {
            when (ui.page) {
                Page.SELECT -> SelectPage()
                Page.PREPARE -> PreparePage()
                Page.PLAY -> PlayPage()
            }
            ui.errorText?.let { msg ->
                AlertDialog(
                    onDismissRequest = { ui.errorText = null },
                    confirmButton = {
                        TextButton(onClick = { ui.errorText = null }) { Text("知道了") }
                    },
                    title = { Text("发送失败") },
                    text = { Text(msg) }
                )
            }
        }
    }

    override fun onDestroy() {
        destroySenderAsync(sender)
        super.onDestroy()
    }

    // ===== select =====

    private fun resolveItem(uri: Uri): SendItem? {
        var name: String? = null
        var size = -1L
        contentResolver.query(uri, null, null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val si = c.getColumnIndex(OpenableColumns.SIZE)
                if (ni >= 0) name = c.getString(ni)
                if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
            }
        }
        val wireName = name?.substringAfterLast('/')?.trim().orEmpty()
        if (wireName.isEmpty() || size < 0) return null
        return SendItem(SendItem.KIND_FILE, wireName, size, uri = uri)
    }

    private fun addTextItem(text: String) {
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty()) return
        val usedNames = ui.items.mapTo(mutableSetOf()) { item ->
            java.text.Normalizer.normalize(item.displayName, java.text.Normalizer.Form.NFC)
        }
        ui.items = ui.items + SendItem(
            SendItem.KIND_UTF8_TEXT,
            uniqueSendDisplayName(usedNames, SendItem.DEFAULT_TEXT_NAME),
            bytes.size.toLong(), text = bytes
        )
    }

    private fun startSend() {
        if (ui.items.isEmpty()) return
        val total = try {
            validateSendItems(ui.items)
        } catch (e: IllegalArgumentException) {
            ui.errorText = e.message ?: "所选内容不符合 AF2 发送约束"
            return
        }
        val activeSender = sender
        val preset = PRESETS[ui.presetIndex]
        ui.page = Page.PREPARE
        ui.prepDone = 0
        ui.prepTotal = total
        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val prepared = activeSender.prepare(ui.items) { done, total ->
                    // Throttle state writes: Compose only needs ~10 Hz here.
                    if (done == total || done - ui.prepDone > 4 * 1024 * 1024) {
                        ui.prepDone = done
                        ui.prepTotal = total.coerceAtLeast(1)
                    }
                }
                activeSender.build(prepared, ui.items, preset.symbolSize, preset.fps, QR_PER_FRAME, REDUNDANCY_PCT)
                withContext(Dispatchers.Main) {
                    // The user may have backgrounded the app mid-prepare —
                    // entering play now would stream QRs to an invisible screen.
                    if (!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) {
                        replaceAndDestroySender(activeSender)
                        ui.page = Page.SELECT
                        return@withContext
                    }
                    ui.page = Page.PLAY
                    enterPlayMode()
                    startRenderLoop(preset, activeSender)
                    startStatsLoop(activeSender)
                    startPrefetchLoop(activeSender)
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    ui.page = Page.SELECT
                    ui.errorText = e.message ?: e.toString()
                }
            }
        }
    }

    // ===== play =====

    private fun enterPlayMode() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val lp = window.attributes
        lp.screenBrightness = 1.0f // receiver cameras need max contrast
        window.attributes = lp
    }

    private fun exitPlayMode() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val lp = window.attributes
        lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = lp
    }

    private fun startRenderLoop(preset: SpeedPreset, activeSender: SenderSessionManager) {
        val frameMs = (1000L / preset.fps).coerceAtLeast(8)
        lifecycleScope.launch(Dispatchers.Default) {
            while (isActive && ui.page == Page.PLAY) {
                val t0 = System.nanoTime()
                try {
                    val batch = activeSender.nextQr(QR_PER_FRAME)
                    val frame = renderFrame(batch)
                    withContext(Dispatchers.Main) {
                        // stopPlay swaps the manager before native work already
                        // in flight necessarily returns. Do not let that stale
                        // result repopulate the cleared SELECT-page state.
                        if (ui.page == Page.PLAY && sender === activeSender) ui.frame = frame
                    }
                } catch (e: Exception) {
                    withContext(Dispatchers.Main) {
                        // A deliberate stop destroys the session mid-frame —
                        // that's not a failure, so only surface errors while
                        // playback is still meant to be running.
                        if (ui.page == Page.PLAY) {
                            stopPlay()
                            ui.errorText = e.message ?: e.toString()
                        }
                    }
                    break
                }
                val elapsedMs = (System.nanoTime() - t0) / 1_000_000
                delay((frameMs - elapsedMs).coerceAtLeast(1))
            }
        }
    }

    private fun renderFrame(batch: QrBatch): QrFrame {
        val tile = batch.tiles.first()
        val side = tile.side
        val pixels = IntArray(side * side)
        var i = 0
        for (y in 0 until side) {
            for (x in 0 until side) {
                pixels[i++] = if (tile.isDark(x, y)) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
            }
        }
        val bmp = Bitmap.createBitmap(pixels, side, side, Bitmap.Config.ARGB_8888)
        return QrFrame(bmp.asImageBitmap(), side, ++frameSeq)
    }

    private fun startStatsLoop(activeSender: SenderSessionManager) {
        lifecycleScope.launch(Dispatchers.Main) {
            while (isActive && ui.page == Page.PLAY) {
                val s = withContext(Dispatchers.Default) { activeSender.stats() }
                if (s != null && ui.page == Page.PLAY && sender === activeSender) {
                    val mbps = s.throughputBps / (1024.0 * 1024.0)
                    val mb = s.bytes / (1024.0 * 1024.0)
                    ui.statsText = "%.1f fps · %.2f MiB/s · 已发 %.1f MiB · 第 %d 轮".format(
                        s.fps, mbps, mb, s.epoch
                    )
                }
                delay(250)
            }
        }
    }

    private fun startPrefetchLoop(activeSender: SenderSessionManager) {
        lifecycleScope.launch(Dispatchers.IO) {
            while (isActive && ui.page == Page.PLAY) {
                try {
                    activeSender.prefetchNextChunk()
                } catch (_: Exception) {
                    // staging failure surfaces on the render loop's next retry
                }
                delay(100)
            }
        }
    }

    private fun stopPlay() {
        val activeSender = sender
        // Stop every loop before waiting for the manager's native-call lock.
        // The old instance is retired on a daemon thread; a fresh one is ready
        // immediately if the user starts another send.
        ui.page = Page.SELECT
        replaceAndDestroySender(activeSender)
        exitPlayMode()
        ui.frame = null
        ui.statsText = ""
    }

    private fun replaceAndDestroySender(retiring: SenderSessionManager) {
        if (sender === retiring) sender = SenderSessionManager(contentResolver)
        destroySenderAsync(retiring)
    }

    private fun destroySenderAsync(retiring: SenderSessionManager) {
        Thread({ retiring.destroy() }, "airferry-sender-destroy").apply {
            isDaemon = true
            start()
        }
    }

    override fun onPause() {
        super.onPause()
        if (ui.page == Page.PLAY) stopPlay()
    }

    // ===== composables =====

    @Composable
    private fun SelectPage() {
        var showTextDialog by remember { mutableStateOf(false) }
        // 折叠屏内屏 / 平板上限制内容列宽（640dp）并居中，避免单列被拉满整幅屏。
        Box(
            modifier = Modifier.fillMaxSize().background(BgDark),
            contentAlignment = Alignment.TopCenter
        ) {
        Column(
            modifier = Modifier
                .fillMaxHeight()
                .widthIn(max = 640.dp)
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .padding(20.dp)
        ) {
            Text(
                "发送文件", color = TextPrimary, fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(16.dp))

            // Speed preset chips
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PRESETS.forEachIndexed { i, p ->
                    FilterChip(
                        selected = ui.presetIndex == i,
                        onClick = { ui.presetIndex = i },
                        label = { Text("${p.label} ${p.symbolSize}B·${p.fps}fps", fontSize = 12.sp) }
                    )
                }
            }
            Spacer(Modifier.height(16.dp))

            // Pending items
            Surface(
                color = CardBg, shape = RoundedCornerShape(12.dp),
                modifier = Modifier.weight(1f).fillMaxWidth()
            ) {
                if (ui.items.isEmpty()) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(
                            "尚未选择内容\n（发送期间请保持屏幕常亮并调亮）",
                            color = TextSecondary, textAlign = TextAlign.Center
                        )
                    }
                } else {
                    LazyColumn(contentPadding = PaddingValues(12.dp)) {
                        itemsIndexed(ui.items) { idx, item ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)
                            ) {
                                Icon(
                                    if (item.kind == SendItem.KIND_UTF8_TEXT) Icons.Default.Email
                                    else Icons.AutoMirrored.Filled.InsertDriveFile,
                                    contentDescription = null, tint = Accent
                                )
                                Spacer(Modifier.width(10.dp))
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        item.displayName, color = TextPrimary, fontSize = 14.sp,
                                        maxLines = 1, overflow = TextOverflow.Ellipsis
                                    )
                                    Text(
                                        formatSize(item.size), color = TextSecondary, fontSize = 12.sp
                                    )
                                }
                                IconButton(onClick = {
                                    ui.items = ui.items.toMutableList().also { it.removeAt(idx) }
                                }) {
                                    Icon(Icons.Default.Close, contentDescription = "移除", tint = TextSecondary)
                                }
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(16.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = { pickFiles.launch(arrayOf("*/*")) },
                    modifier = Modifier.weight(1f)
                ) { Text("选文件") }
                OutlinedButton(
                    onClick = { showTextDialog = true },
                    modifier = Modifier.weight(1f)
                ) { Text("写文字") }
            }
            Spacer(Modifier.height(12.dp))
            Button(
                onClick = { startSend() },
                enabled = ui.items.isNotEmpty(),
                modifier = Modifier.fillMaxWidth().height(52.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Accent)
            ) { Text("开始发送", fontSize = 16.sp, fontWeight = FontWeight.Bold) }
        }
        }

        if (showTextDialog) {
            var text by remember { mutableStateOf("") }
            AlertDialog(
                onDismissRequest = { showTextDialog = false },
                title = { Text("发送文字") },
                text = {
                    OutlinedTextField(
                        value = text, onValueChange = { text = it },
                        minLines = 3, modifier = Modifier.fillMaxWidth()
                    )
                },
                confirmButton = {
                    TextButton(onClick = {
                        addTextItem(text)
                        showTextDialog = false
                    }) { Text("加入列表") }
                },
                dismissButton = {
                    TextButton(onClick = { showTextDialog = false }) { Text("取消") }
                }
            )
        }
    }

    @Composable
    private fun PreparePage() {
        val pct = (ui.prepDone.toFloat() / ui.prepTotal).coerceIn(0f, 1f)
        Box(
            modifier = Modifier.fillMaxSize().background(BgDark),
            contentAlignment = Alignment.Center
        ) {
            Column(
                modifier = Modifier.widthIn(max = 560.dp).padding(32.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text("正在准备…", color = TextPrimary, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
                Text(
                    "哈希计算 ${formatSize(ui.prepDone)} / ${formatSize(ui.prepTotal)}",
                    color = TextSecondary, fontSize = 14.sp
                )
                Spacer(Modifier.height(24.dp))
                LinearProgressIndicator(
                    progress = { pct },
                    modifier = Modifier.fillMaxWidth().height(6.dp)
                )
            }
        }
    }

    @Composable
    private fun PlayPage() {
        Column(modifier = Modifier.fillMaxSize().background(Color.White)) {
            // QR area: white background + quiet zone, nearest-neighbor upscale.
            Box(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentAlignment = Alignment.Center
            ) {
                val frame = ui.frame
                if (frame != null) {
                    // `seq` is the recomposition key; bitmap alone can miss equal-size frames.
                    key(frame.seq) {
                        Canvas(Modifier.fillMaxSize()) {
                            val quiet = 4
                            val cell = min(size.width, size.height) / (frame.side + 2 * quiet)
                            val img = (cell * frame.side).roundToInt()
                            val off = Offset(
                                (size.width - img) / 2f,
                                (size.height - img) / 2f
                            )
                            drawImage(
                                frame.bitmap,
                                dstOffset = IntOffset(off.x.roundToInt(), off.y.roundToInt()),
                                dstSize = IntSize(img, img),
                                filterQuality = FilterQuality.None
                            )
                        }
                    }
                } else {
                    CircularProgressIndicator(color = Accent)
                }
            }
            // Stats bar：宽屏（折叠内屏/平板）下限制列宽并居中；navigationBars
            // padding 避开全面屏手势区，QR 区域本身保持纯白全幅。
            Surface(color = BgDark) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                    Column(
                        Modifier
                            .widthIn(max = 560.dp)
                            .navigationBarsPadding()
                            .fillMaxWidth()
                            .padding(16.dp)
                    ) {
                    Text(
                        ui.statsText.ifEmpty { "正在启动…" },
                        color = Success, fontSize = 14.sp,
                        modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "请用接收端摄像头对准本屏幕扫码",
                        color = TextSecondary, fontSize = 12.sp,
                        modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = { stopPlay() },
                        modifier = Modifier.fillMaxWidth().height(48.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEF4444))
                    ) { Text("停止发送") }
                    }
                }
            }
        }
    }

    private fun formatSize(bytes: Long): String = when {
        bytes >= 1L shl 30 -> "%.2f GiB".format(bytes / (1024.0 * 1024.0 * 1024.0))
        bytes >= 1L shl 20 -> "%.2f MiB".format(bytes / (1024.0 * 1024.0))
        bytes >= 1L shl 10 -> "%.1f KiB".format(bytes / 1024.0)
        else -> "$bytes B"
    }

    private companion object {
        const val REDUNDANCY_PCT = 5 // web sender default (DEFAULT_CONFIG in types.ts)

        /** QR tiles per played frame (single-code today). The render loop and
         *  the sender build must share this constant: it feeds the channel-rate
         *  estimate (fps × symbolSize × QR count) that gates p6 escalation, so a
         *  future multi-QR tier must not update one site and forget the other. */
        const val QR_PER_FRAME = 1
    }
}
