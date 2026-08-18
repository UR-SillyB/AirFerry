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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Message
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.airferry.app.scan.Af2LedgerStore
import com.airferry.app.scan.ContentStore
import com.airferry.app.scan.CreateNamedDocument
import com.airferry.app.scan.FileTransfer
import com.airferry.app.scan.SafTreeExporter
import com.airferry.app.scan.TextLike
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

private val BgDark = Color(0xFF0F172A)
private val CardBg = Color(0xFF1E293B)
private val Accent = Color(0xFF3B82F6)
private val TextPrimary = Color(0xFFF1F5F9)
private val TextSecondary = Color(0xFF94A3B8)
private val DeleteRed = Color(0xFFEF4444)
private val Success = Color(0xFF22C55E)
private val SelectHighlight = Color(0xFF1D4ED8)

/** One row in the history list backed by ContentStore. */
private sealed class Row {
    data class FileRow(
        val entry: ContentStore.Entry,
        val blob: File,
        val preview: String,
    ) : Row()

    data class BundleRow(
        val bundleId: String,
        val title: String,
        val members: List<ContentStore.Entry>,
        val totalSize: Long,
        val createdAt: Long,
    ) : Row()

    val key: String
        get() = when (this) {
            is FileRow -> entry.id
            is BundleRow -> "b:$bundleId"
        }
}

class FileListActivity : ComponentActivity() {

    private val saveQueue = ArrayDeque<Pair<File, String>>()
    private var pendingSave: Pair<File, String>? = null
    private var pendingTreeSave: List<Pair<File, String>> = emptyList()
    private var indexErrorShown = false

    /**
     * Single background thread for the history list load and the SAF save
     * copies. Both previously ran on the main thread:
     *  - [loadRows] → [ContentStore.listEntries] is `@Synchronized` on the
     *    ContentStore object and can block for the whole duration of an
     *    in-flight archive ([ContentStore.putFile] holds the same monitor for
     *    tens of seconds on large segmented transfers) → guaranteed ANR.
     *  - SAF save copies whole-streamed blobs of up to hundreds of MiB → ANR.
     * A single thread also keeps the sequential save queue strictly ordered.
     */
    private val bgExecutor = Executors.newSingleThreadExecutor()

    private val createDocument = registerForActivityResult(
        CreateNamedDocument()
    ) { uri: Uri? ->
        val job = pendingSave
        pendingSave = null
        if (uri != null && job != null && job.first.exists()) {
            // The full stream copy runs on the background executor (M6); the
            // queue only advances after the copy finishes, preserving the
            // one-SAF-dialog-at-a-time sequential semantics.
            Toast.makeText(this, "保存中…", Toast.LENGTH_SHORT).show()
            try {
                bgExecutor.execute {
                    val error: String? = try {
                        contentResolver.openOutputStream(uri)?.use { out ->
                            job.first.inputStream().use { it.copyTo(out) }
                        }
                        null
                    } catch (e: Exception) {
                        e.message
                    }
                    runOnUiThread {
                        if (error != null) {
                            Toast.makeText(this, "保存失败: $error", Toast.LENGTH_LONG).show()
                        }
                        advanceSaveQueue()
                    }
                }
            } catch (_: RejectedExecutionException) {
                // Activity is already being destroyed.
                runOnUiThread { advanceSaveQueue() }
            }
        } else {
            advanceSaveQueue()
        }
    }

    private val openSaveTree = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri: Uri? ->
        val jobs = pendingTreeSave
        pendingTreeSave = emptyList()
        if (uri == null || jobs.isEmpty()) return@registerForActivityResult
        Toast.makeText(this, "正在保存 ${jobs.size} 个文件…", Toast.LENGTH_SHORT).show()
        try {
            bgExecutor.execute {
                var saved = 0
                val error = try {
                    saved = SafTreeExporter.copyAll(
                        this,
                        uri,
                        jobs.map { (file, name) -> SafTreeExporter.Item(file, name) },
                    )
                    null
                } catch (e: Exception) {
                    e.message ?: e.javaClass.simpleName
                }
                runOnUiThread {
                    if (error == null) {
                        Toast.makeText(this, "已保存 $saved 个文件", Toast.LENGTH_LONG).show()
                    } else {
                        Toast.makeText(this, "保存失败（已保存 $saved 个）: $error", Toast.LENGTH_LONG).show()
                    }
                }
            }
        } catch (_: RejectedExecutionException) {
            // Activity is already being destroyed.
        }
    }

    /** Continue the sequential save flow after a copy (or a cancelled dialog). */
    private fun advanceSaveQueue() {
        if (isFinishing || isDestroyed) return
        if (saveQueue.isEmpty()) {
            Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show()
        } else {
            launchNextSave()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        bgExecutor.shutdown()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { FileListScreen() }
    }

    @OptIn(ExperimentalFoundationApi::class)
    @Composable
    private fun FileListScreen() {
        // null = root (top-level entries + bundle groups); non-null = inside a bundle
        var openBundleId by remember { mutableStateOf<String?>(null) }
        var rows by remember { mutableStateOf<List<Row>>(emptyList()) }
        var pendingTransfers by remember { mutableStateOf<List<Af2LedgerStore.PendingTransfer>>(emptyList()) }
        var selection by remember { mutableStateOf<Set<String>?>(null) }
        var pendingDelete by remember { mutableStateOf<List<Row>?>(null) }
        var pendingClearAll by remember { mutableStateOf(false) }
        val inSelectionMode = selection != null

        // H3: loadRows touches the ContentStore monitor (listEntries is
        // @Synchronized and blocks behind a long putFile archive) plus segment
        // ledgers on disk — it must never run on the main thread. The
        // generation counter discards stale results so a slow load can never
        // overwrite a newer one (e.g. rapidly entering/leaving a bundle).
        var rowsGeneration by remember { mutableStateOf(0) }
        fun refresh() {
            if (isFinishing || isDestroyed) return
            val filter = openBundleId
            val gen = ++rowsGeneration
            try {
                bgExecutor.execute {
                    val loaded = loadRows(filter)
                    val pending = if (filter == null) Af2LedgerStore.listPendingTransfers(cacheDir) else emptyList()
                    runOnUiThread {
                        if (gen == rowsGeneration) {
                            rows = loaded
                            pendingTransfers = pending
                        }
                    }
                }
            } catch (_: RejectedExecutionException) {
                // Activity destroyed mid-flight — nothing left to refresh.
            }
        }
        // Initial (and config-change) load — async, off the main thread.
        LaunchedEffect(Unit) { refresh() }
        fun exitSelection() { selection = null }
        fun toggle(row: Row) {
            val k = row.key
            selection = selection?.let { if (k in it) it - k else it + k }
        }

        fun clearAll() {
            // H3: clearAll takes the same @Synchronized ContentStore monitor an
            // archive may hold for tens of seconds — never on the main thread.
            bgExecutor.execute {
                ContentStore.clearAll(this)
                runOnUiThread {
                    // The destroy-vs-callback race: this runnable can run after
                    // onDestroy already shut the executor down (refresh() is
                    // fail-safe, but the toast must not fire either).
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    openBundleId = null
                    refresh()
                    exitSelection()
                    Toast.makeText(this, "已清空", Toast.LENGTH_SHORT).show()
                }
            }
        }

        Column(modifier = Modifier.fillMaxSize().background(BgDark)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(20.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (openBundleId != null) {
                    TextButton(onClick = {
                        openBundleId = null
                        refresh()
                        exitSelection()
                    }) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = null,
                            tint = Accent,
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(Modifier.width(4.dp))
                        Text("返回", color = Accent, fontSize = 14.sp)
                    }
                    Spacer(Modifier.width(8.dp))
                    val title = rows.filterIsInstance<Row.FileRow>().firstOrNull()?.entry?.bundleTitle
                        ?: "打包"
                    Text(
                        title, color = TextPrimary,
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
                        "接收历史",
                        color = TextPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.weight(1f)
                    )
                    if (rows.isNotEmpty()) {
                        TextButton(onClick = { pendingClearAll = true }) {
                            Text("清空", color = DeleteRed, fontSize = 14.sp)
                        }
                    }
                }
            }

            if (openBundleId == null && pendingTransfers.isNotEmpty()) {
                val totalPendingBytes = pendingTransfers.sumOf { it.diskBytes }
                Card(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF332005)),
                    shape = RoundedCornerShape(8.dp)
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "${pendingTransfers.size} 个未完成断点传输",
                                color = Color(0xFFFBBF24),
                                fontWeight = FontWeight.Bold,
                                fontSize = 14.sp
                            )
                            TextButton(
                                onClick = {
                                    // A §12 recovery in ScanActivity may be streaming
                                    // from these exact spill/ledger files right now —
                                    // deleting them under it aborts a fully received
                                    // transfer. Refuse while one is running.
                                    if (ScanActivity.recoveryActive.get()) {
                                        Toast.makeText(
                                            this@FileListActivity,
                                            "有传输正在恢复中，请稍后再清理断点",
                                            Toast.LENGTH_SHORT
                                        ).show()
                                        return@TextButton
                                    }
                                    bgExecutor.execute {
                                        Af2LedgerStore.discardAllPending(cacheDir)
                                        runOnUiThread { refresh() }
                                    }
                                },
                                contentPadding = PaddingValues(0.dp)
                            ) {
                                Text("清理断点", color = DeleteRed, fontSize = 12.sp)
                            }
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = "已占用磁盘 ${ScanActivity.formatSize(totalPendingBytes)} · 再次对准原二维码即可接续传输",
                            color = Color(0xFFFDE68A),
                            fontSize = 12.sp
                        )
                    }
                }
            }

            if (rows.isEmpty() && pendingTransfers.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("暂无接收文件或待恢复任务", color = TextSecondary, fontSize = 16.sp, textAlign = TextAlign.Center)
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f).padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                    contentPadding = PaddingValues(bottom = if (inSelectionMode) 88.dp else 24.dp)
                ) {
                    items(rows, key = { it.key }) { row ->
                        val selected = selection?.contains(row.key) == true
                        when (row) {
                            is Row.FileRow -> EntryCard(
                                row = row,
                                selected = selected,
                                inSelectionMode = inSelectionMode,
                                onClick = {
                                    if (inSelectionMode) toggle(row)
                                    else openEntry(row)
                                },
                                onLongClick = {
                                    if (!inSelectionMode) selection = setOf(row.key)
                                    else toggle(row)
                                },
                                onSingleDelete = { pendingDelete = listOf(row) },
                            )
                            is Row.BundleRow -> BundleCard(
                                row = row,
                                selected = selected,
                                inSelectionMode = inSelectionMode,
                                onClick = {
                                    if (inSelectionMode) toggle(row)
                                    else {
                                        openBundleId = row.bundleId
                                        refresh()
                                        exitSelection()
                                    }
                                },
                                onLongClick = {
                                    if (!inSelectionMode) selection = setOf(row.key)
                                    else toggle(row)
                                },
                                onSingleDelete = { pendingDelete = listOf(row) },
                            )
                        }
                    }
                }
            }

            if (inSelectionMode && !selection.isNullOrEmpty()) {
                val selectedRows = rows.filter { it.key in selection!! }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(CardBg)
                        .padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceEvenly
                ) {
                    BottomAction(Icons.Default.Share, "分享", Success) {
                        shareRows(selectedRows)
                    }
                    BottomAction(Icons.Default.Save, "保存", Accent) {
                        saveRows(selectedRows)
                    }
                    BottomAction(Icons.Default.Delete, "删除", DeleteRed) {
                        pendingDelete = selectedRows
                    }
                }
            }
        }

        if (pendingDelete != null) {
            val n = pendingDelete!!.size
            AlertDialog(
                onDismissRequest = { pendingDelete = null },
                title = { Text("删除确认") },
                text = { Text("确定删除选中的 $n 项？此操作不可撤销。") },
                confirmButton = {
                    TextButton(onClick = {
                        val doomed = pendingDelete ?: emptyList()
                        pendingDelete = null
                        // H3: deleteEntry/deleteBundle/discard take the same
                        // @Synchronized ContentStore monitor (plus disk I/O) —
                        // run off the main thread, refresh once done.
                        bgExecutor.execute {
                            for (r in doomed) deleteRow(r)
                            runOnUiThread {
                                if (isFinishing || isDestroyed) return@runOnUiThread
                                refresh()
                                exitSelection()
                                Toast.makeText(this, "已删除", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }) { Text("删除", color = DeleteRed) }
                },
                dismissButton = {
                    TextButton(onClick = { pendingDelete = null }) { Text("取消") }
                },
            )
        }

        if (pendingClearAll) {
            AlertDialog(
                onDismissRequest = { pendingClearAll = false },
                title = { Text("清空全部") },
                text = { Text("确定清空所有已接收文件？此操作不可撤销。") },
                confirmButton = {
                    TextButton(onClick = {
                        pendingClearAll = false
                        clearAll()
                    }) { Text("清空", color = DeleteRed) }
                },
                dismissButton = {
                    TextButton(onClick = { pendingClearAll = false }) { Text("取消") }
                },
            )
        }
    }

    private fun loadRows(bundleFilter: String?): List<Row> {
        val all = try {
            ContentStore.listEntries(this)
        } catch (e: IllegalStateException) {
            if (!indexErrorShown) {
                indexErrorShown = true
                // loadRows runs on a background thread — never touch the view
                // hierarchy from there; hop to the main thread for the toast.
                runOnUiThread {
                    Toast.makeText(this, e.message ?: "接收历史索引损坏", Toast.LENGTH_LONG).show()
                }
            }
            return emptyList()
        }
        if (bundleFilter != null) {
            return all.filter { it.bundleId == bundleFilter }
                .sortedByDescending { it.createdAt }
                .map { e ->
                    Row.FileRow(
                        e,
                        e.blobFile(this),
                        previewOf(e),
                    )
                }
        }
        val topFiles = all.filter { it.bundleId == null }
        val bundles = all.filter { it.bundleId != null }.groupBy { it.bundleId!! }
        val fileRows = topFiles.map { e ->
            Row.FileRow(e, e.blobFile(this), previewOf(e))
        }
        val bundleRows = bundles.map { (id, members) ->
            Row.BundleRow(
                bundleId = id,
                title = members.firstOrNull()?.bundleTitle ?: "打包",
                members = members,
                totalSize = members.sumOf { it.size },
                createdAt = members.maxOfOrNull { it.createdAt } ?: 0L,
            )
        }
        return (fileRows + bundleRows).sortedByDescending {
            when (it) {
                is Row.FileRow -> it.entry.createdAt
                is Row.BundleRow -> it.createdAt
            }
        }
    }

    private fun previewOf(e: ContentStore.Entry): String {
        if (e.kind != "text" && !TextLike.isTextLikeName(e.name)) return ""
        if (!TextLike.fitsTextUi(e.size)) return ""
        return try {
            val f = e.blobFile(this)
            if (!f.exists()) return ""
            f.readText(Charsets.UTF_8)
                .lineSequence()
                .firstOrNull { it.isNotBlank() }
                ?.trim()
                ?.take(60) ?: ""
        } catch (_: Exception) {
            ""
        }
    }

    private fun deleteRow(row: Row) {
        when (row) {
            is Row.FileRow -> ContentStore.deleteEntry(this, row.entry.id)
            is Row.BundleRow -> ContentStore.deleteBundle(this, row.bundleId)
        }
    }

    private fun shareRows(rows: List<Row>) {
        val pairs = flatten(rows)
        if (pairs.isEmpty()) return
        try {
            val shared = pairs.filter { it.first.exists() }
            val uris = ArrayList<Uri>()
            for ((file, name) in shared) {
                uris.add(FileTransfer.shareUri(this, file, name))
            }
            if (uris.isEmpty()) {
                Toast.makeText(this, "没有可分享的文件", Toast.LENGTH_SHORT).show()
                return
            }
            val shareIntent = Intent(
                if (uris.size > 1) Intent.ACTION_SEND_MULTIPLE else Intent.ACTION_SEND
            ).apply {
                type = FileTransfer.commonMimeType(shared.map { it.second })
                if (uris.size > 1) putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                else putExtra(Intent.EXTRA_STREAM, uris[0])
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(shareIntent, "分享 ${uris.size} 个文件"))
        } catch (e: Exception) {
            Toast.makeText(this, "分享失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun saveRows(rows: List<Row>) {
        val pairs = flatten(rows)
        if (pairs.isEmpty()) {
            Toast.makeText(this, "没有可保存的文件", Toast.LENGTH_SHORT).show()
            return
        }
        // A directory picker is both less tedious for multi-save and the only
        // SAF flow that can preserve a bundle member such as `dir/a.txt` as an
        // actual subdirectory. Keep ACTION_CREATE_DOCUMENT for a lone flat file.
        if (pairs.size > 1 || pairs.any { (_, name) -> '/' in name || '\\' in name }) {
            saveQueue.clear()
            pendingSave = null
            pendingTreeSave = pairs
            openSaveTree.launch(null)
            return
        }
        saveQueue.clear()
        pendingSave = null
        pairs.forEach { saveQueue.add(it) }
        launchNextSave()
    }

    private fun flatten(rows: List<Row>): List<Pair<File, String>> {
        val out = ArrayList<Pair<File, String>>()
        for (r in rows) {
            when (r) {
                is Row.FileRow -> if (r.blob.exists()) out.add(r.blob to r.entry.name)
                is Row.BundleRow -> {
                    for (m in r.members) {
                        val f = m.blobFile(this)
                        if (f.exists()) out.add(f to m.name)
                    }
                }
            }
        }
        return out
    }

    private fun launchNextSave() {
        if (saveQueue.isEmpty()) return
        val job = saveQueue.removeFirst()
        pendingSave = job
        try {
            createDocument.launch(job.second)
        } catch (e: Exception) {
            pendingSave = null
            Toast.makeText(this, "保存失败: ${e.message}", Toast.LENGTH_LONG).show()
            launchNextSave()
        }
    }

    private fun openEntry(row: Row.FileRow) {
        val e = row.entry
        val file = row.blob
        if (!file.exists()) {
            Toast.makeText(this, "文件已丢失", Toast.LENGTH_SHORT).show()
            return
        }
        val isText = e.kind == "text" || TextLike.isTextLikeName(e.name)
        if (isText && TextLike.fitsTextUi(e.size)) {
            try {
                val bytes = file.readBytes()
                val text = TextLike.decodeUtf8Strict(bytes)
                if (text != null) {
                    val expectedCrc = e.crcHex.toLongOrNull(16) ?: 0L
                    startActivity(
                        Intent(this, ReceiveTextActivity::class.java).apply {
                            putExtra("FILE_PATH", file.absolutePath)
                            putExtra("FILE_NAME", e.name)
                            putExtra("ENTRY_ID", e.id)
                            putExtra("CRC32", expectedCrc)
                            putExtra("CRC32_RECEIVED", ScanActivity.crc32OfBytes(bytes))
                            putExtra("CRC32_UNKNOWN", e.crcUnknown)
                        }
                    )
                    return
                }
            } catch (_: Exception) {
                Toast.makeText(this, "无法读取文字", Toast.LENGTH_SHORT).show()
                return
            }
        }
        Thread {
            // M4: stream the CRC (64 KiB buffer, O(1) memory). The previous
            // `file.readBytes()` whole-loaded blobs of up to hundreds of MiB
            // and OOM-crashed — an Error the old `catch (Exception)` could not
            // intercept. CRC is display-only here, so any failure (including
            // OOM) just degrades to "unknown" (-1).
            val receivedCrc = try {
                ScanActivity.crc32OfFile(file)
            } catch (t: Throwable) {
                -1L
            }
            val expectedCrc = e.crcHex.toLongOrNull(16) ?: 0L
            val intent = Intent(this, ReceiveDetailActivity::class.java).apply {
                putExtra("FILE_PATH", file.absolutePath)
                putExtra("FILE_NAME", e.name)
                putExtra("FILE_SIZE", e.size)
                putExtra("ENTRY_ID", e.id)
                putExtra("CRC32", expectedCrc)
                putExtra("CRC32_RECEIVED", receivedCrc)
                putExtra("CRC32_UNKNOWN", e.crcUnknown)
                putExtra("RESAVE", true)
            }
            runOnUiThread { startActivity(intent) }
        }.start()
    }

    @OptIn(ExperimentalFoundationApi::class)
    @Composable
    private fun EntryCard(
        row: Row.FileRow,
        selected: Boolean,
        inSelectionMode: Boolean,
        onClick: () -> Unit,
        onLongClick: () -> Unit,
        onSingleDelete: () -> Unit,
    ) {
        val e = row.entry
        val isText = e.kind == "text" || TextLike.isTextLikeName(e.name)
        val displayTitle =
            if (isText && (e.name == "文字消息.txt" || e.name == "文字消息")) "文字消息"
            else e.name
        val cardColor by animateColorAsState(if (selected) SelectHighlight else CardBg, label = "c")
        var showDelete by remember { mutableStateOf(false) }
        val dateStr = java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault())
            .format(java.util.Date(e.createdAt))

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
                    Icon(
                        if (isText) Icons.AutoMirrored.Filled.Message else Icons.Default.Description,
                        contentDescription = null, tint = Accent, modifier = Modifier.size(32.dp)
                    )
                    Spacer(Modifier.width(12.dp))
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(displayTitle, color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                    if (isText && row.preview.isNotEmpty()) {
                        Text(row.preview, color = TextSecondary, fontSize = 12.sp, maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                    }
                    Text("${ScanActivity.formatSize(e.size)} · $dateStr", color = TextSecondary, fontSize = 12.sp)
                }
                if (!inSelectionMode) {
                    IconButton(onClick = { showDelete = true }) {
                        Icon(Icons.Default.Delete, contentDescription = "删除", tint = DeleteRed, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
        if (showDelete) {
            AlertDialog(
                onDismissRequest = { showDelete = false },
                title = { Text(if (isText) "删除文字消息" else "删除文件") },
                text = { Text(if (isText) "确定删除这条文字消息？" else "确定删除「${e.name}」？") },
                confirmButton = {
                    TextButton(onClick = {
                        showDelete = false
                        onSingleDelete()
                    }) { Text("删除", color = DeleteRed) }
                },
                dismissButton = {
                    TextButton(onClick = { showDelete = false }) { Text("取消") }
                },
            )
        }
    }

    @OptIn(ExperimentalFoundationApi::class)
    @Composable
    private fun BundleCard(
        row: Row.BundleRow,
        selected: Boolean,
        inSelectionMode: Boolean,
        onClick: () -> Unit,
        onLongClick: () -> Unit,
        onSingleDelete: () -> Unit,
    ) {
        val cardColor by animateColorAsState(if (selected) SelectHighlight else CardBg, label = "bc")
        var showDelete by remember { mutableStateOf(false) }
        val dateStr = java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault())
            .format(java.util.Date(row.createdAt))

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
                    Text(row.title, color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                    Text(
                        "${row.members.size} 个文件 · ${ScanActivity.formatSize(row.totalSize)} · $dateStr",
                        color = TextSecondary, fontSize = 12.sp
                    )
                }
                if (!inSelectionMode) {
                    IconButton(onClick = { showDelete = true }) {
                        Icon(Icons.Default.Delete, contentDescription = "删除", tint = DeleteRed, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
        if (showDelete) {
            AlertDialog(
                onDismissRequest = { showDelete = false },
                title = { Text("删除打包") },
                text = { Text("确定删除「${row.title}」及其中 ${row.members.size} 个文件？") },
                confirmButton = {
                    TextButton(onClick = {
                        showDelete = false
                        onSingleDelete()
                    }) { Text("删除", color = DeleteRed) }
                },
                dismissButton = {
                    TextButton(onClick = { showDelete = false }) { Text("取消") }
                },
            )
        }
    }

    @Composable
    private fun BottomAction(icon: ImageVector, label: String, tint: Color, onClick: () -> Unit) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .padding(8.dp)
                .clickable(onClick = onClick)
        ) {
            Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(26.dp))
            Spacer(Modifier.height(4.dp))
            Text(label, color = tint, fontSize = 13.sp)
        }
    }
}
