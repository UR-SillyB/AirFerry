package com.easytransfer.app.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import java.io.File

private val BgDark = Color(0xFF0F172A)
private val CardBg = Color(0xFF1E293B)
private val Accent = Color(0xFF3B82F6)
private val TextPrimary = Color(0xFFF1F5F9)
private val TextSecondary = Color(0xFF94A3B8)
private val DeleteRed = Color(0xFFEF4444)
private val Success = Color(0xFF22C55E)
private val SelectHighlight = Color(0xFF1D4ED8)

class FileListActivity : ComponentActivity() {

    /** Pending files to save via the CreateDocument launcher. Drained one URI
     *  per callback until the queue is empty. SAF's CreateDocument picks one
     *  destination at a time, so multi-save walks the queue sequentially. */
    private val saveQueue = ArrayDeque<File>()
    /** The source file whose CreateDocument prompt is currently in flight.
     *  Correlated back to the returned URI in the callback. */
    private var pendingSaveSource: File? = null

    private val createDocument = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream")
    ) { uri: Uri? ->
        val src = pendingSaveSource
        pendingSaveSource = null
        if (uri != null && src != null && src.exists()) {
            try {
                contentResolver.openOutputStream(uri)?.use { out ->
                    src.inputStream().use { it.copyTo(out) }
                }
            } catch (e: Exception) {
                Toast.makeText(this, "保存失败: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
        // Launch the next pending save (if any). When the queue drains, confirm.
        if (saveQueue.isEmpty()) {
            Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show()
        } else {
            launchNextSave()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { FileListScreen() }
    }

    @OptIn(ExperimentalFoundationApi::class)
    @Composable
    private fun FileListScreen() {
        val dir = remember { File(getExternalFilesDir(null), "received") }
        var fileList by remember {
            mutableStateOf(loadFiles(dir))
        }
        // Selection mode: null = browsing (click opens); non-empty set = a
        // selection session (click toggles). Using a single nullable Set lets
        // the UI distinguish "not selecting" from "selecting 0 items".
        var selection by remember { mutableStateOf<Set<File>?>(null) }
        // Pending bulk-delete confirmation (set when the user taps Delete in
        // the action bar; the dialog renders from this state).
        var pendingDelete by remember { mutableStateOf<List<File>?>(null) }
        val inSelectionMode = selection != null
        fun toggle(f: File) {
            selection = selection?.let { if (f in it) it - f else it + f }
        }
        fun clearSelection() { selection = null }
        fun exitSelection() { selection = null }
        fun refresh() { fileList = loadFiles(dir) }

        Column(modifier = Modifier.fillMaxSize().background(BgDark)) {
            // Top bar: title + count, or (in selection mode) a "N selected" bar
            // with a clear/close action.
            Row(
                modifier = Modifier.fillMaxWidth().padding(20.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    if (inSelectionMode) "已选 ${selection!!.size} 个"
                    else "已接收文件",
                    color = TextPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f)
                )
                if (inSelectionMode) {
                    TextButton(onClick = { exitSelection() }) {
                        Icon(Icons.Default.Close, contentDescription = "退出选择", tint = TextPrimary)
                        Spacer(Modifier.width(4.dp))
                        Text("取消", color = TextPrimary)
                    }
                } else {
                    Text("${fileList.size} 个", color = TextSecondary, fontSize = 14.sp)
                }
            }
            HorizontalDivider(color = Color(0xFF334155))

            if (fileList.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Default.Description, contentDescription = null, tint = TextSecondary, modifier = Modifier.size(64.dp))
                        Spacer(modifier = Modifier.height(16.dp))
                        Text("暂无已接收的文件", color = TextSecondary, fontSize = 16.sp, textAlign = TextAlign.Center)
                        Spacer(modifier = Modifier.height(8.dp))
                        Text("扫描二维码接收文件后，文件会显示在这里。", color = TextSecondary, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 40.dp))
                    }
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f).padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(vertical = 16.dp)
                ) {
                    items(fileList, key = { it.name }) { file ->
                        val selected = inSelectionMode && file in (selection ?: emptySet())
                        FileCard(
                            file = file,
                            selected = selected,
                            inSelectionMode = inSelectionMode,
                            onClick = {
                                if (inSelectionMode) toggle(file)
                                else openFileForResave(file)
                            },
                            onLongClick = {
                                // Long-press enters selection mode seeded with this file.
                                if (!inSelectionMode) selection = setOf(file)
                                else toggle(file)
                            },
                            onSingleDelete = { deletedFile ->
                                deleteFile(deletedFile)
                                refresh()
                            }
                        )
                    }
                }
            }

            // Selection-mode action bar (replaces the bottom "返回" button while
            // selecting). Share / Save / Delete act on the whole selection.
            if (inSelectionMode) {
                val selectedFiles = selection?.mapNotNull { f -> fileList.find { it.name == f.name } } ?: emptyList()
                val hasSelection = selectedFiles.isNotEmpty()
                Surface(color = CardBg, shadowElevation = 8.dp) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        horizontalArrangement = Arrangement.SpaceEvenly
                    ) {
                        ActionButton(
                            icon = Icons.Default.Share,
                            label = "分享",
                            color = Success,
                            enabled = hasSelection
                        ) { shareFiles(selectedFiles) }
                        ActionButton(
                            icon = Icons.Default.Save,
                            label = "保存",
                            color = Accent,
                            enabled = hasSelection
                        ) { saveFiles(selectedFiles) }
                        ActionButton(
                            icon = Icons.Default.Delete,
                            label = "删除",
                            color = DeleteRed,
                            enabled = hasSelection
                        ) {
                            // Defer the actual delete behind a confirmation dialog
                            // (batch delete is irreversible, same as single delete).
                            pendingDelete = selectedFiles
                        }
                    }
                }
            } else {
                OutlinedButton(
                    onClick = { finish() },
                    modifier = Modifier.fillMaxWidth().padding(16.dp).height(50.dp),
                    shape = RoundedCornerShape(12.dp)
                ) { Text("返回", color = TextPrimary, fontSize = 16.sp) }
            }
        }

        // Bulk-delete confirmation. Renders on top of the list when the user
        // taps Delete in the selection action bar.
        pendingDelete?.let { files ->
            AlertDialog(
                onDismissRequest = { pendingDelete = null },
                title = { Text("删除文件") },
                text = { Text("确定删除选中的 ${files.size} 个文件？此操作不可撤销。") },
                confirmButton = {
                    TextButton(onClick = {
                        files.forEach { deleteFile(it) }
                        refresh()
                        clearSelection()
                        pendingDelete = null
                        Toast.makeText(this, "已删除 ${files.size} 个文件", Toast.LENGTH_SHORT).show()
                    }) {
                        Text("删除", color = DeleteRed)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { pendingDelete = null }) {
                        Text("取消")
                    }
                }
            )
        }
    }

    @OptIn(ExperimentalFoundationApi::class)
    @Composable
    private fun ActionButton(
        icon: androidx.compose.ui.graphics.vector.ImageVector,
        label: String,
        color: Color,
        enabled: Boolean,
        onClick: () -> Unit
    ) {
        val tint = if (enabled) color else TextSecondary
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.combinedClickable(enabled = enabled, onClick = { onClick() })
        ) {
            Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(26.dp))
            Spacer(Modifier.height(4.dp))
            Text(label, color = tint, fontSize = 13.sp)
        }
    }

    @OptIn(ExperimentalFoundationApi::class)
    @Composable
    private fun FileCard(
        file: File,
        selected: Boolean,
        inSelectionMode: Boolean,
        onClick: () -> Unit,
        onLongClick: () -> Unit,
        onSingleDelete: (File) -> Unit
    ) {
        val metaFile = remember(file) { File(file.parentFile, "${file.name}.meta") }
        val meta: Triple<String, Long, Long> = remember(file) {
            if (metaFile.exists()) {
                val lines = metaFile.readLines()
                val name = lines.getOrElse(0) { file.name }
                val size = lines.getOrElse(1) { file.length().toString() }.toLongOrNull() ?: file.length()
                val crc = lines.getOrElse(2) { "0" }.toLongOrNull(16) ?: 0L
                Triple(name, size, crc)
            } else {
                Triple(file.name, file.length(), 0L)
            }
        }
        val origName = meta.first
        val origSize = meta.second

        var showDeleteDialog by remember { mutableStateOf(false) }
        // Highlight the whole card when selected.
        val cardColor by animateColorAsState(if (selected) SelectHighlight else CardBg, label = "cardBg")

        Card(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = onClick, onLongClick = onLongClick),
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = cardColor)
        ) {
            Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                if (inSelectionMode) {
                    // Selection checkbox / indicator replaces the file icon while
                    // selecting, so the affordance is obvious.
                    Checkbox(
                        checked = selected,
                        onCheckedChange = { onClick() },
                        colors = CheckboxDefaults.colors(checkedColor = Accent, uncheckedColor = TextSecondary),
                        modifier = Modifier.size(24.dp)
                    )
                    Spacer(Modifier.width(12.dp))
                } else {
                    Icon(Icons.Default.Description, contentDescription = null, tint = Accent, modifier = Modifier.size(32.dp))
                    Spacer(Modifier.width(12.dp))
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(origName, color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                    val dateStr = java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault()).format(java.util.Date(file.lastModified()))
                    Text("${ScanActivity.formatSize(origSize)} · $dateStr", color = TextSecondary, fontSize = 12.sp)
                }
                // Per-item delete is hidden in selection mode (bulk delete is in
                // the action bar); keep it as the quick path in browse mode.
                if (!inSelectionMode) {
                    IconButton(onClick = { showDeleteDialog = true }) {
                        Icon(
                            Icons.Default.Delete,
                            contentDescription = "删除",
                            tint = DeleteRed,
                            modifier = Modifier.size(20.dp)
                        )
                    }
                }
            }
        }

        if (showDeleteDialog) {
            AlertDialog(
                onDismissRequest = { showDeleteDialog = false },
                title = { Text("删除文件") },
                text = { Text("确定删除「$origName」？此操作不可撤销。") },
                confirmButton = {
                    TextButton(onClick = {
                        showDeleteDialog = false
                        onSingleDelete(file)
                    }) {
                        Text("删除", color = DeleteRed)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showDeleteDialog = false }) {
                        Text("取消")
                    }
                }
            )
        }
    }

    // ===== Batch operations =====

    /**
     * Share multiple files in one ACTION_SEND_MULTIPLE. Each file is copied to
     * `cacheDir/share` under its original (sanitized) name so share targets see
     * the real filename, then exposed via FileProvider.
     */
    private fun shareFiles(files: List<File>) {
        if (files.isEmpty()) return
        try {
            val shareDir = File(cacheDir, "share")
            if (!shareDir.exists()) shareDir.mkdirs()
            val authority = "${packageName}.fileprovider"
            val uris = ArrayList<Uri>()
            for (src in files) {
                if (!src.exists()) continue
                val metaFile = File(src.parentFile, "${src.name}.meta")
                val displayName = if (metaFile.exists()) {
                    metaFile.readLines().getOrElse(0) { src.name }
                } else src.name
                val safeName = com.easytransfer.app.scan.FileNameUtil.sanitize(displayName)
                val shareFile = com.easytransfer.app.scan.FileNameUtil.uniqueTarget(shareDir, safeName)
                src.copyTo(shareFile, overwrite = true)
                uris.add(FileProvider.getUriForFile(this, authority, shareFile))
            }
            if (uris.isEmpty()) {
                Toast.makeText(this, "没有可分享的文件", Toast.LENGTH_SHORT).show()
                return
            }
            val shareIntent = Intent(if (uris.size > 1) Intent.ACTION_SEND_MULTIPLE else Intent.ACTION_SEND).apply {
                type = "application/octet-stream"
                if (uris.size > 1) {
                    putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                } else {
                    putExtra(Intent.EXTRA_STREAM, uris[0])
                }
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(shareIntent, "分享 ${uris.size} 个文件"))
        } catch (e: Exception) {
            Toast.makeText(this, "分享失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Save multiple files. Each file is queued and the user is prompted for one
     * destination filename at a time via CreateDocument (SAF has no native
     * multi-target picker for arbitrary content). The launcher drains the queue.
     */
    private fun saveFiles(files: List<File>) {
        if (files.isEmpty()) return
        saveQueue.clear()
        pendingSaveSource = null
        for (src in files) {
            if (src.exists()) saveQueue.add(src)
        }
        if (saveQueue.isEmpty()) {
            Toast.makeText(this, "没有可保存的文件", Toast.LENGTH_SHORT).show()
            return
        }
        launchNextSave()
    }

    /** Pop the next file off the save queue and prompt for its destination. */
    private fun launchNextSave() {
        if (saveQueue.isEmpty()) return
        val src = saveQueue.removeFirst()
        pendingSaveSource = src
        // Derive the suggested filename from the .meta sidecar (original name).
        val metaFile = File(src.parentFile, "${src.name}.meta")
        val displayName = if (metaFile.exists()) {
            metaFile.readLines().getOrElse(0) { src.name }
        } else src.name
        try {
            createDocument.launch(displayName)
        } catch (e: Exception) {
            pendingSaveSource = null
            Toast.makeText(this, "保存失败: ${e.message}", Toast.LENGTH_LONG).show()
            launchNextSave()
        }
    }

    private fun openFileForResave(file: File) {
        val metaFile = File(file.parentFile, "${file.name}.meta")
        var fileName = file.name
        var fileSize = file.length()
        var crc32 = 0L
        // Default to "unknown" — a fresh scan always sets this explicitly, and
        // old .meta files (pre-line-4) lack the flag, so assume unknown rather
        // than falsely showing a 0==0 "verified" result.
        var crcUnknown = true
        if (metaFile.exists()) {
            val lines = metaFile.readLines()
            fileName = lines.getOrElse(0) { file.name }
            fileSize = lines.getOrElse(1) { file.length().toString() }.toLongOrNull() ?: file.length()
            crc32 = lines.getOrElse(2) { "0" }.toLongOrNull(16) ?: 0L
            // Line 4 (added later): explicit "crcUnknown" boolean. Absent on
            // old sidecars → keep the default true.
            crcUnknown = lines.getOrElse(3) { "true" }.trim() != "false"
        }
        val intent = Intent(this, ReceiveDetailActivity::class.java).apply {
            putExtra("FILE_PATH", file.absolutePath)
            putExtra("FILE_NAME", fileName)
            putExtra("FILE_SIZE", fileSize)
            putExtra("CRC32", crc32)
            putExtra("CRC32_RECEIVED", crc32)
            putExtra("CRC32_UNKNOWN", crcUnknown)
            // Re-save path: don't copy into received/ again (avoids duplicates).
            putExtra("RESAVE", true)
        }
        startActivity(intent)
    }

    private fun deleteFile(file: File) {
        val metaFile = File(file.parentFile, "${file.name}.meta")
        file.delete()
        metaFile.delete()
    }

    private fun loadFiles(dir: File): List<File> =
        if (dir.exists()) dir.listFiles { f -> !f.name.endsWith(".meta") }
            ?.sortedByDescending { it.lastModified() }?.toList() ?: emptyList()
        else emptyList()
}
