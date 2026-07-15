package com.airferry.app.ui

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
import androidx.compose.material.icons.automirrored.filled.Message
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
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

/** One item in the file list: either a regular file or a bundle directory. */
private sealed class ListItem {
    /** A regular received file (with optional .meta sidecar). */
    data class FileItem(val file: java.io.File) : ListItem()
    /** A bundle subdirectory (e.g. "发送_0622_001234"). */
    data class DirItem(val dir: java.io.File) : ListItem()
}

/**
 * Parsed .meta sidecar + (for text) a first-line preview, used by FileCard.
 *  - [isText] is true when the .meta's 5th line is `kind=text`.
 *  - [preview] is the first non-empty line of the .txt (text items only).
 */
private data class FileMeta(
    val name: String,
    val size: Long,
    val isText: Boolean,
    val preview: String,
)

class FileListActivity : ComponentActivity() {

    private val saveQueue = ArrayDeque<java.io.File>()
    private var pendingSaveSource: java.io.File? = null

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
        val rootDir = remember { java.io.File(getExternalFilesDir(null), "received") }
        // Directory stack: start at root; push when entering a bundle dir.
        var dirStack by remember { mutableStateOf(listOf(rootDir)) }
        val currentDir = dirStack.last()
        // Items in the current directory (files + subdirectories).
        var items by remember { mutableStateOf(loadItems(currentDir)) }
        // null = browsing, non-empty = selection session.
        var selection by remember { mutableStateOf<Set<String>?>(null) }
        var pendingDelete by remember { mutableStateOf<List<ListItem>?>(null) }
        // Pending clear-all confirmation.
        var pendingClearAll by remember { mutableStateOf(false) }
        val inSelectionMode = selection != null

        fun toggle(item: ListItem) {
            val key = when (item) {
                is ListItem.FileItem -> item.file.name
                is ListItem.DirItem -> item.dir.name
            }
            selection = selection?.let { if (key in it) it - key else it + key }
        }
        fun exitSelection() { selection = null }
        fun refresh() { items = loadItems(currentDir) }

        // Navigate into a bundle directory.
        fun enterDir(dir: java.io.File) {
            dirStack = dirStack + dir
            items = loadItems(dir)
            exitSelection()
        }
        // Go back to the parent directory.
        fun leaveDir() {
            if (dirStack.size > 1) {
                dirStack = dirStack.dropLast(1)
                items = loadItems(dirStack.last())
                exitSelection()
            }
        }

        // Recursively delete everything under root.
        fun clearAllFiles() {
            rootDir.listFiles()?.forEach { it.deleteRecursively() }
            refresh()
            exitSelection()
            Toast.makeText(this@FileListActivity, "已清空", Toast.LENGTH_SHORT).show()
        }

        Column(modifier = Modifier.fillMaxSize().background(BgDark)) {
            // Top bar
            Row(
                modifier = Modifier.fillMaxWidth().padding(20.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (dirStack.size > 1) {
                    // In a subdirectory: show back arrow + dir name
                    TextButton(onClick = { leaveDir() }) {
                        Text("← 返回", color = Accent, fontSize = 14.sp)
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        currentDir.name, color = TextPrimary,
                        fontSize = 18.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.weight(1f),
                        maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                    )
                } else if (inSelectionMode) {
                    Text(
                        "已选 ${selection!!.size} 个",
                        color = TextPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(onClick = { exitSelection() }) {
                        Icon(Icons.Default.Close, contentDescription = "退出选择", tint = TextPrimary)
                        Spacer(Modifier.width(4.dp))
                        Text("取消", color = TextPrimary)
                    }
                } else {
                    Text(
                        "已接收文件",
                        color = TextPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.weight(1f)
                    )
                    Text("${items.size} 项", color = TextSecondary, fontSize = 14.sp)
                    Spacer(Modifier.width(12.dp))
                    // 清空按钮：仅在根目录且 items 非空时显示
                    if (items.isNotEmpty()) {
                        TextButton(onClick = { pendingClearAll = true }) {
                            Icon(Icons.Default.Delete, contentDescription = "清空", tint = DeleteRed, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(2.dp))
                            Text("清空", color = DeleteRed, fontSize = 13.sp)
                        }
                    }
                }
            }
            HorizontalDivider(color = Color(0xFF334155))

            if (items.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Default.Description, contentDescription = null, tint = TextSecondary, modifier = Modifier.size(64.dp))
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            if (dirStack.size > 1) "此目录为空"
                            else "暂无已接收的文件",
                            color = TextSecondary, fontSize = 16.sp, textAlign = TextAlign.Center
                        )
                        if (dirStack.size == 1) {
                            Spacer(modifier = Modifier.height(8.dp))
                            Text("扫描二维码接收文件后，文件会显示在这里。", color = TextSecondary, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 40.dp))
                        }
                    }
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f).padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(vertical = 16.dp)
                ) {
                    items(items, key = {
                        when (it) {
                            is ListItem.FileItem -> "f:${it.file.name}"
                            is ListItem.DirItem -> "d:${it.dir.name}"
                        }
                    }) { item ->
                        val key = when (item) {
                            is ListItem.FileItem -> item.file.name
                            is ListItem.DirItem -> item.dir.name
                        }
                        val selected = inSelectionMode && key in (selection ?: emptySet())

                        when (item) {
                            is ListItem.FileItem -> FileCard(
                                file = item.file,
                                selected = selected,
                                inSelectionMode = inSelectionMode,
                                onClick = {
                                    if (inSelectionMode) toggle(item)
                                    else openFileForResave(item.file)
                                },
                                onLongClick = {
                                    if (!inSelectionMode) selection = setOf(key)
                                    else toggle(item)
                                },
                                onSingleDelete = { f ->
                                    deleteFile(f)
                                    refresh()
                                }
                            )
                            is ListItem.DirItem -> DirCard(
                                dir = item.dir,
                                selected = selected,
                                inSelectionMode = inSelectionMode,
                                onClick = {
                                    if (inSelectionMode) toggle(item)
                                    else enterDir(item.dir)
                                },
                                onLongClick = {
                                    if (!inSelectionMode) selection = setOf(key)
                                    else toggle(item)
                                }
                            )
                        }
                    }
                }
            }

            // Bottom action bar (selection mode or back button)
            if (inSelectionMode) {
                val selectedItems = selection?.mapNotNull { key ->
                    items.find {
                        val k = when (it) {
                            is ListItem.FileItem -> it.file.name
                            is ListItem.DirItem -> it.dir.name
                        }
                        k == key
                    }
                } ?: emptyList()
                val hasSelection = selectedItems.isNotEmpty()
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
                        ) { shareItems(selectedItems) }
                        ActionButton(
                            icon = Icons.Default.Save,
                            label = "保存",
                            color = Accent,
                            enabled = hasSelection
                        ) { saveItems(selectedItems.filterIsInstance<ListItem.FileItem>().map { it.file }) }
                        ActionButton(
                            icon = Icons.Default.Delete,
                            label = "删除",
                            color = DeleteRed,
                            enabled = hasSelection
                        ) {
                            pendingDelete = selectedItems
                        }
                    }
                }
            } else if (dirStack.size == 1) {
                OutlinedButton(
                    onClick = { finish() },
                    modifier = Modifier.fillMaxWidth().padding(16.dp).height(50.dp),
                    shape = RoundedCornerShape(12.dp)
                ) { Text("返回", color = TextPrimary, fontSize = 16.sp) }
            } else {
                // Inside a bundle subdirectory, no bottom bar needed.
            }
        }

        // Bulk-delete confirmation
        pendingDelete?.let { list ->
            val files = list.filterIsInstance<ListItem.FileItem>().map { it.file }
            val dirs = list.filterIsInstance<ListItem.DirItem>().map { it.dir }
            val total = files.size + dirs.size
            AlertDialog(
                onDismissRequest = { pendingDelete = null },
                title = { Text("删除文件") },
                text = { Text("确定删除选中的 $total 项？此操作不可撤销。") },
                confirmButton = {
                    TextButton(onClick = {
                        files.forEach { deleteFile(it) }
                        dirs.forEach { it.deleteRecursively() }
                        refresh()
                        exitSelection()
                        pendingDelete = null
                        Toast.makeText(this, "已删除 $total 项", Toast.LENGTH_SHORT).show()
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

        // Clear-all confirmation
        if (pendingClearAll) {
            AlertDialog(
                onDismissRequest = { pendingClearAll = false },
                title = { Text("清空所有文件") },
                text = { Text("确定删除所有已接收的文件？此操作不可撤销。") },
                confirmButton = {
                    TextButton(onClick = {
                        pendingClearAll = false
                        clearAllFiles()
                    }) {
                        Text("清空", color = DeleteRed)
                    }
                },
                dismissButton = {
                    TextButton(onClick = { pendingClearAll = false }) {
                        Text("取消")
                    }
                }
            )
        }
    }

    // ===== ListItem helpers =====

    /** List both files and subdirectories in [dir]. Files first, then dirs. */
    private fun loadItems(dir: java.io.File): List<ListItem> {
        if (!dir.exists()) return emptyList()
        val files = dir.listFiles { f -> !f.name.endsWith(".meta") && f.isFile }
            ?.sortedByDescending { it.lastModified() }
            ?.map { ListItem.FileItem(it) } ?: emptyList()
        val subdirs = dir.listFiles { f -> f.isDirectory }
            ?.sortedByDescending { it.lastModified() }
            ?.map { ListItem.DirItem(it) } ?: emptyList()
        return files + subdirs
    }

    private fun deleteFile(file: java.io.File) {
        val metaFile = java.io.File(file.parentFile, "${file.name}.meta")
        file.delete()
        metaFile.delete()
    }

    // ===== Cards =====

    @OptIn(ExperimentalFoundationApi::class)
    @Composable
    private fun FileCard(
        file: java.io.File,
        selected: Boolean,
        inSelectionMode: Boolean,
        onClick: () -> Unit,
        onLongClick: () -> Unit,
        onSingleDelete: (java.io.File) -> Unit
    ) {
        val metaFile = remember(file) { java.io.File(file.parentFile, "${file.name}.meta") }
        // meta: name / size / isText / preview (first line of the text, for text items)
        val meta = remember(file) {
            var name = file.name
            var size = file.length()
            var isText = false
            var preview = ""
            if (metaFile.exists()) {
                val lines = metaFile.readLines()
                name = lines.getOrElse(0) { file.name }
                size = lines.getOrElse(1) { file.length().toString() }.toLongOrNull() ?: file.length()
                isText = lines.getOrElse(4) { "" }.trim() == "kind=text"
            }
            // Also treat common text extensions as text even without kind=text
            // (user-sent .md/.json/…, or older archives).
            if (!isText) {
                isText = com.airferry.app.scan.TextLike.isTextLikeName(name)
            }
            // For text items, read the first non-empty line as a preview. Cheap
            // (texts are small) and makes the history entry recognizable.
            if (isText) {
                preview = try {
                    file.readText(Charsets.UTF_8)
                        .lineSequence()
                        .firstOrNull { it.isNotBlank() }
                        ?.trim()
                        ?.take(60) ?: ""
                } catch (_: Exception) { "" }
            }
            FileMeta(name, size, isText, preview)
        }
        val origName = meta.name
        val origSize = meta.size
        val isText = meta.isText
        // 文字项主标题不裸露「文字消息.txt」文件名——它对接收场景没有意义，
        // 且与首行预览重复。统一显示「文字消息」，首行预览作副标题。文件名仅在
        // 真正「保存为文件 / 分享」时用到（见 ReceiveTextActivity 的 saveAs）。
        // Keep the real filename for text-like docs (readme.md, notes.json);
        // only the generic ETTEXTv1 archive name collapses to「文字消息」.
        val displayTitle =
            if (isText && (origName == "文字消息.txt" || origName == "文字消息")) "文字消息"
            else origName

        var showDeleteDialog by remember { mutableStateOf(false) }
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
                    Checkbox(
                        checked = selected,
                        onCheckedChange = { onClick() },
                        colors = CheckboxDefaults.colors(checkedColor = Accent, uncheckedColor = TextSecondary),
                        modifier = Modifier.size(24.dp)
                    )
                    Spacer(Modifier.width(12.dp))
                } else {
                    // Text transfers get a message icon so they're visually
                    // distinct from ordinary files in the history.
                    Icon(
                        if (isText) Icons.AutoMirrored.Filled.Message else Icons.Default.Description,
                        contentDescription = null, tint = Accent, modifier = Modifier.size(32.dp)
                    )
                    Spacer(Modifier.width(12.dp))
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(displayTitle, color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                    val dateStr = java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault()).format(java.util.Date(file.lastModified()))
                    if (isText && meta.preview.isNotEmpty()) {
                        // Text item: show the first line as a preview instead of
                        // a bare size, so the entry is recognizable at a glance.
                        Text(meta.preview, color = TextSecondary, fontSize = 12.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                        Text("${ScanActivity.formatSize(origSize)} · $dateStr", color = TextSecondary, fontSize = 12.sp)
                    } else {
                        Text("${ScanActivity.formatSize(origSize)} · $dateStr", color = TextSecondary, fontSize = 12.sp)
                    }
                }
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
                title = { Text(if (isText) "删除文字消息" else "删除文件") },
                text = { Text(if (isText) "确定删除这条文字消息？此操作不可撤销。" else "确定删除「$origName」？此操作不可撤销。") },
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

    @OptIn(ExperimentalFoundationApi::class)
    @Composable
    private fun DirCard(
        dir: java.io.File,
        selected: Boolean,
        inSelectionMode: Boolean,
        onClick: () -> Unit,
        onLongClick: () -> Unit
    ) {
        val fileCount = remember(dir) {
            dir.listFiles { f -> !f.name.endsWith(".meta") }?.size ?: 0
        }
        val totalSize = remember(dir) {
            dir.listFiles { f -> !f.name.endsWith(".meta") }
                ?.sumOf { it.length() } ?: 0L
        }
        val dateStr = remember(dir) {
            java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault())
                .format(java.util.Date(dir.lastModified()))
        }
        val cardColor by animateColorAsState(if (selected) SelectHighlight else CardBg, label = "dirCard")

        Card(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = onClick, onLongClick = onLongClick),
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = cardColor)
        ) {
            Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                if (inSelectionMode) {
                    Checkbox(
                        checked = selected,
                        onCheckedChange = { onClick() },
                        colors = CheckboxDefaults.colors(checkedColor = Accent, uncheckedColor = TextSecondary),
                        modifier = Modifier.size(24.dp)
                    )
                    Spacer(Modifier.width(12.dp))
                } else {
                    Icon(Icons.Default.Folder, contentDescription = null, tint = Accent, modifier = Modifier.size(32.dp))
                    Spacer(Modifier.width(12.dp))
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(dir.name, color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                    Text("${fileCount} 个文件 · ${ScanActivity.formatSize(totalSize)} · $dateStr", color = TextSecondary, fontSize = 12.sp)
                }
            }
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

    // ===== Batch operations =====

    private fun shareItems(items: List<ListItem>) {
        val files = items.flatMap {
            when (it) {
                is ListItem.FileItem -> listOf(it.file)
                is ListItem.DirItem -> it.dir.listFiles { f -> !f.name.endsWith(".meta") }?.toList() ?: emptyList()
            }
        }
        if (files.isEmpty()) return
        try {
            val shareDir = java.io.File(cacheDir, "share")
            if (!shareDir.exists()) shareDir.mkdirs()
            val authority = "${packageName}.fileprovider"
            val uris = ArrayList<Uri>()
            for (src in files) {
                if (!src.exists()) continue
                val metaFile = java.io.File(src.parentFile, "${src.name}.meta")
                val displayName = if (metaFile.exists()) {
                    metaFile.readLines().getOrElse(0) { src.name }
                } else src.name
                val safeName = com.airferry.app.scan.FileNameUtil.sanitize(displayName)
                val shareFile = com.airferry.app.scan.FileNameUtil.uniqueTarget(shareDir, safeName)
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

    private fun saveItems(files: List<java.io.File>) {
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

    private fun launchNextSave() {
        if (saveQueue.isEmpty()) return
        val src = saveQueue.removeFirst()
        pendingSaveSource = src
        val metaFile = java.io.File(src.parentFile, "${src.name}.meta")
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

    private fun openFileForResave(file: java.io.File) {
        val metaFile = java.io.File(file.parentFile, "${file.name}.meta")
        var fileName = file.name
        var fileSize = file.length()
        var expectedCrc = 0L
        var crcUnknown = true
        var isText = false
        if (metaFile.exists()) {
            val lines = metaFile.readLines()
            fileName = lines.getOrElse(0) { file.name }
            fileSize = lines.getOrElse(1) { file.length().toString() }.toLongOrNull() ?: file.length()
            // The CRC's known/unknown state is derived from the stored hex
            // string itself (line 3), NOT the boolean flag (line 4): the flag's
            // semantics flipped once in archiveText (it wrote `crcKnown`
            // instead of `crcUnknown`), and a stale `.meta` written by an older
            // build carries the wrong polarity. The hex string is the source of
            // truth — "unknown" (or absent) means no CRC; any other value means
            // we have a real expected CRC to compare against.
            val crcStr = lines.getOrElse(2) { "unknown" }.trim()
            expectedCrc = crcStr.toLongOrNull(16) ?: 0L
            crcUnknown = crcStr == "unknown" || crcStr.isEmpty()
            // Optional 5th line `kind=text` marks a text transfer (archived as a
            // .txt). Route it to ReceiveTextActivity (copy/share) instead of the
            // generic file detail screen.
            isText = lines.getOrElse(4) { "" }.trim() == "kind=text"
        }
        if (!isText) {
            isText = com.airferry.app.scan.TextLike.isTextLikeName(fileName)
        }
        if (isText && com.airferry.app.scan.TextLike.fitsTextUi(file.length())) {
            // Text / text-like doc: open the copy/share screen (no re-archive).
            // CRC over on-disk bytes (must match what archiveTextAs / file detail
            // stored in .meta). Invalid UTF-8 or oversize → fall through to file detail.
            try {
                val bytes = file.readBytes()
                val text = com.airferry.app.scan.TextLike.decodeUtf8Strict(bytes)
                if (text != null) {
                    val intent = Intent(this, ReceiveTextActivity::class.java).apply {
                        putExtra("TEXT", text)
                        putExtra("FILE_NAME", fileName)
                        putExtra("CRC32", expectedCrc)
                        putExtra("CRC32_RECEIVED", ScanActivity.crc32OfBytes(bytes))
                        putExtra("CRC32_UNKNOWN", crcUnknown)
                    }
                    startActivity(intent)
                    return
                }
            } catch (_: Exception) {
                Toast.makeText(this, "无法读取文字", Toast.LENGTH_SHORT).show()
                return
            }
            // Invalid UTF-8 with text-like name → treat as ordinary file below.
        }
        // Off-load the disk read + CRC to a background thread so a multi-MB file
        // doesn't freeze the UI on click. We compute the ACTUAL CRC of the bytes
        // on disk (not the expected value) so a corrupted/partially-overwritten
        // file surfaces as a real mismatch in ReceiveDetailActivity, instead of
        // the old behaviour of setting received == expected (which always read
        // "校验通过" even for a damaged file).
        val finalFileName = fileName
        val finalFileSize = fileSize
        val finalExpectedCrc = expectedCrc
        val finalCrcUnknown = crcUnknown
        Toast.makeText(this, "正在校验…", Toast.LENGTH_SHORT).show()
        Thread {
            val receivedCrc = try {
                file.readBytes().let { ScanActivity.crc32OfBytes(it) }
            } catch (_: Exception) {
                // If the file can't be read it's effectively unavailable; fall
                // back to a sentinel that won't match any real expected CRC.
                -1L
            }
            val intent = Intent(this, ReceiveDetailActivity::class.java).apply {
                putExtra("FILE_PATH", file.absolutePath)
                putExtra("FILE_NAME", finalFileName)
                putExtra("FILE_SIZE", finalFileSize)
                putExtra("CRC32", finalExpectedCrc)
                putExtra("CRC32_RECEIVED", receivedCrc)
                putExtra("CRC32_UNKNOWN", finalCrcUnknown)
                putExtra("RESAVE", true)
            }
            runOnUiThread { startActivity(intent) }
        }.start()
    }
}
