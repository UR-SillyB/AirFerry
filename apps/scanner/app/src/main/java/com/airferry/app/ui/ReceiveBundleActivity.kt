package com.airferry.app.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.airferry.app.scan.CreateNamedDocument
import com.airferry.app.scan.FileTransfer
import com.airferry.app.scan.SafTreeExporter
import com.airferry.app.scan.TextLike
import java.io.File

private val BgDark = Color(0xFF0F172A)
private val CardBg = Color(0xFF1E293B)
private val Accent = Color(0xFF3B82F6)
private val TextPrimary = Color(0xFFF1F5F9)
private val TextSecondary = Color(0xFF94A3B8)
private val Success = Color(0xFF22C55E)
private val Error = Color(0xFFEF4444)

/**
 * Detail screen for a recovered multi-file bundle.
 *
 * Lists every recovered file with its size. Individual members use
 * ACTION_CREATE_DOCUMENT; Save All selects one SAF directory and preserves
 * the bundle's sanitized relative hierarchy. The entire set can also be
 * shared via ACTION_SEND_MULTIPLE.
 *
 * Files are passed via three parallel string-array extras ("FILE_PATHS",
 * "FILE_NAMES", "FILE_SIZES") rather than a Parcelable to avoid adding the
 * kotlin-parcelize plugin to the build.
 */
class ReceiveBundleActivity : ComponentActivity() {

    /** One recovered file: ContentStore blob path + logical relative name + size. */
    data class FileInfo(
        val filePath: String,
        val name: String,
        val size: Long
    )

    private val files = mutableStateListOf<FileInfo>()
    private var expectedCrc: Long = 0L
    private var receivedCrc: Long = 0L
    private var crcUnknown: Boolean = true

    /** Index of the member currently being saved through ACTION_CREATE_DOCUMENT. */
    private var pendingSaveIndex = 0

    /**
     * Background thread for the SAF save copies (M6): whole-streaming a blob of
     * up to hundreds of MiB on the main thread (the activity-result callback)
     * is a guaranteed ANR. Single thread keeps concurrent "save" taps ordered.
     */
    private val saveExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()

    private val saveOne = registerForActivityResult(
        CreateNamedDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            saveToUri(uri, files.getOrNull(pendingSaveIndex))
        }
    }

    private fun saveAllToTree(treeUri: Uri) {
        val snapshot = files.toList()
        Toast.makeText(this, "正在保存 ${snapshot.size} 个文件…", Toast.LENGTH_SHORT).show()
        saveExecutor.execute {
            var saved = 0
            val error = try {
                saved = SafTreeExporter.copyAll(
                    this,
                    treeUri,
                    snapshot.map { SafTreeExporter.Item(File(it.filePath), it.name) },
                )
                null
            } catch (e: Exception) {
                e.message ?: e.javaClass.simpleName
            }
            runOnUiThread {
                if (error == null) {
                    Toast.makeText(this, "已保存 $saved 个文件（目录结构已保留）", Toast.LENGTH_LONG).show()
                } else {
                    Toast.makeText(this, "保存失败（已保存 $saved 个）: $error", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    /** Save-all chooses one directory and preserves bundle subdirectories. */
    private val saveAllTree = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri: Uri? ->
        if (uri != null) saveAllToTree(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Keep the screen lit after recovery (see ReceiveDetailActivity).
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val paths = intent.getStringArrayListExtra("FILE_PATHS") ?: arrayListOf()
        val names = intent.getStringArrayListExtra("FILE_NAMES") ?: arrayListOf()
        val sizes = intent.getStringArrayListExtra("FILE_SIZES") ?: arrayListOf()
        files.clear()
        for (i in paths.indices) {
            val name = names.getOrElse(i) { "file_$i" }
            val size = sizes.getOrElse(i) { "0" }.toLongOrNull() ?: 0L
            files.add(FileInfo(paths[i], name, size))
        }
        expectedCrc = intent.getLongExtra("CRC32", 0L)
        receivedCrc = intent.getLongExtra("CRC32_RECEIVED", 0L)
        crcUnknown = intent.getBooleanExtra("CRC32_UNKNOWN", true)

        setContent { BundleDetailScreen() }
    }

    override fun onDestroy() {
        super.onDestroy()
        saveExecutor.shutdown()
    }

    @Composable
    private fun BundleDetailScreen() {
        val crcOk = !crcUnknown && expectedCrc == receivedCrc
        val totalCount = files.size
        val totalSize = files.sumOf { it.size }

        Column(
            modifier = Modifier.fillMaxSize().background(BgDark).padding(20.dp)
        ) {
            // Header card
            Box(
                modifier = Modifier.fillMaxWidth(),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(
                        modifier = Modifier.size(80.dp).clip(CircleShape).background(Success),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(Icons.Default.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(40.dp))
                    }
                    Spacer(modifier = Modifier.height(12.dp))
                    Text("打包文件恢复成功", color = TextPrimary, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text("共 $totalCount 个文件 · ${formatSize(totalSize)}", color = TextSecondary, fontSize = 13.sp)
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // CRC line
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg)
            ) {
                Text(
                    text = when {
                        crcUnknown -> "整体校验：— CRC32 未知（未收到描述符）"
                        crcOk -> "整体校验：CRC32 校验通过"
                        else -> "整体校验：校验失败（数据可能损坏）"
                    },
                    color = when {
                        crcUnknown -> TextSecondary
                        crcOk -> Success
                        else -> Error
                    },
                    fontSize = 13.sp,
                    modifier = Modifier.padding(14.dp)
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            // File list
            LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                // Bundle members are content-addressed: files with identical
                // content share one blob path (ContentStore dedup), so filePath
                // is NOT unique within a bundle and using it as a LazyColumn key
                // crashes with "Key ... already used" once two dedup'd members
                // appear on screen. Key by stable position instead.
                itemsIndexed(files, key = { index, _ -> index }) { _, f ->
                    val looksText = TextLike.isTextLikeName(f.name)
                    // Only readable in the in-memory text UI when it fits; larger
                    // text-like members degrade to the file detail screen.
                    val canOpenText = looksText && TextLike.fitsTextUi(f.size)
                    FileRow(
                        f = f,
                        looksText = looksText,
                        canOpenText = canOpenText,
                        onOpenText = { openAsText(f) },
                        onOpenAsFile = { openAsFile(f) },
                        onSave = {
                            pendingSaveIndex = files.indexOf(f)
                            saveOne.launch(f.name)
                        },
                        onShare = { shareOne(f) },
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Save all + share all
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(
                    onClick = {
                        if (files.isEmpty()) {
                            Toast.makeText(this@ReceiveBundleActivity, "没有可保存的文件", Toast.LENGTH_SHORT).show()
                        } else {
                            saveAllTree.launch(null)
                        }
                    },
                    modifier = Modifier.weight(1f).height(50.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Accent),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Icon(Icons.Default.Save, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(modifier = Modifier.width(6.dp))
                    Text("全部保存", fontSize = 14.sp)
                }
                Button(
                    onClick = { shareAll() },
                    modifier = Modifier.weight(1f).height(50.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Success),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text("分享全部", fontSize = 14.sp)
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            OutlinedButton(
                onClick = { finish() },
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("重新扫码", color = TextPrimary, fontSize = 15.sp)
            }
        }
    }

    @Composable
    private fun FileRow(
        f: FileInfo,
        looksText: Boolean,
        canOpenText: Boolean,
        onOpenText: () -> Unit,
        onOpenAsFile: () -> Unit,
        onSave: () -> Unit,
        onShare: () -> Unit,
    ) {
        // Text-like members are tappable: open the text UI if it fits, otherwise
        // degrade to the file detail screen (so a >2MB .txt/.html still shows its
        // name and can be saved/shared instead of a bare "文件过大" toast).
        val onClick = if (looksText) {
            if (canOpenText) onOpenText else onOpenAsFile
        } else {
            null
        }
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier),
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = CardBg)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        f.name,
                        color = TextPrimary,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                    )
                    Text(
                        formatSize(f.size),
                        color = TextSecondary,
                        fontSize = 12.sp,
                    )
                }
                TextButton(onClick = onSave) { Text("保存", color = Accent, fontSize = 13.sp) }
                TextButton(onClick = onShare) { Text("分享", color = Success, fontSize = 13.sp) }
            }
        }
    }

    /**
     * Open a bundle entry as a text message (copy / share / save .txt).
     * Used for sender-side "添加文字" items materialised as named .txt entries
     * in the AF2 Manifest (kind = FILE; UTF8_TEXT kind is only used for lone
     * text transfers, so mixed batches never carry pure-text entries).
     */
    private fun openAsText(info: FileInfo) {
        val src = File(info.filePath)
        if (!src.exists()) {
            Toast.makeText(this, "文件不可用", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            if (!TextLike.fitsTextUi(src.length())) {
                // A text-like member larger than the in-memory text UI cap is not
                // readable as a String here — fall back to the file detail screen
                // (name / size / save / share) instead of just toasting "文件过大",
                // so the user can still see the file name and act on it.
                openAsFile(info)
                return
            }
            val bytes = src.readBytes()
            if (TextLike.decodeUtf8Strict(bytes) == null) {
                Toast.makeText(this, "该文件不是有效的 UTF-8 文本", Toast.LENGTH_SHORT).show()
                return
            }
            startActivity(
                Intent(this, ReceiveTextActivity::class.java).apply {
                    // M5: 只传 FILE_PATH — ReceiveTextActivity 从落盘文件加载
                    // 文字（其类注释明确设计为从 staged file 加载以避开 Binder
                    // 事务限制）。文本上限 8 MiB，作为 Intent extra 传输必撞
                    // TransactionTooLargeException 直接崩溃。
                    putExtra("FILE_PATH", info.filePath)
                    putExtra("FILE_NAME", info.name)
                    putExtra("CRC32_UNKNOWN", true)
                }
            )
        } catch (e: Exception) {
            Toast.makeText(this, "无法作为文字打开: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Open a bundle member in the generic file detail screen (name / size /
     * CRC / save / share). Used when a text-like member exceeds the in-memory
     * text-UI cap, so the user still sees the file name and can save/share it
     * instead of hitting a bare "文件过大" toast. RESAVE=true keeps the blob in
     * ContentStore and skips the legacy copy-to-received-dir duplicate.
     */
    private fun openAsFile(info: FileInfo) {
        val src = File(info.filePath)
        if (!src.exists()) {
            Toast.makeText(this, "文件不可用", Toast.LENGTH_SHORT).show()
            return
        }
        startActivity(
            Intent(this, ReceiveDetailActivity::class.java).apply {
                putExtra("FILE_PATH", src.absolutePath)
                putExtra("FILE_NAME", info.name)
                putExtra("FILE_SIZE", info.size)
                putExtra("CRC32_UNKNOWN", true)
                putExtra("RESAVE", true)
            }
        )
    }


    private fun saveToUri(uri: Uri, info: FileInfo?) {
        val src = info?.let { File(it.filePath) } ?: return
        // M6: the full stream copy runs on the background executor; the
        // completion toast hops back to the main thread.
        Toast.makeText(this, "保存中…", Toast.LENGTH_SHORT).show()
        saveExecutor.execute {
            val error: String? = try {
                contentResolver.openOutputStream(uri)?.use { out ->
                    src.inputStream().use { it.copyTo(out) }
                }
                null
            } catch (e: Exception) {
                e.message
            }
            runOnUiThread {
                if (error == null) {
                    Toast.makeText(this, "已保存 ${info.name}", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this, "保存失败: $error", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    /** Share a single file via ACTION_SEND (canonical blob path, no share copy). */
    private fun shareOne(info: FileInfo) {
        val src = File(info.filePath)
        if (!src.exists()) {
            Toast.makeText(this, "文件不可用", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val uri = FileTransfer.shareUri(this, src, info.name)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = FileTransfer.mimeType(info.name)
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TITLE, FileTransfer.displayName(info.name))
                putExtra(Intent.EXTRA_TEXT, FileTransfer.displayName(info.name))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(intent, "分享 ${info.name}"))
        } catch (e: Exception) {
            Toast.makeText(this, "分享失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /** Share the whole bundle via ACTION_SEND_MULTIPLE (direct blob URIs). */
    private fun shareAll() {
        try {
            val uris = ArrayList<Uri>()
            val names = ArrayList<String>()
            for (f in files) {
                val src = File(f.filePath)
                if (!src.exists()) continue
                uris.add(FileTransfer.shareUri(this, src, f.name))
                names.add(f.name)
            }
            if (uris.isEmpty()) {
                Toast.makeText(this, "没有可分享的文件", Toast.LENGTH_SHORT).show()
                return
            }
            val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                type = FileTransfer.commonMimeType(names)
                putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                putExtra(
                    Intent.EXTRA_TITLE,
                    if (names.size == 1) FileTransfer.displayName(names[0]) else "${names.size} 个文件",
                )
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(intent, "分享全部文件"))
        } catch (e: Exception) {
            Toast.makeText(this, "分享失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun formatSize(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        if (bytes < 1024 * 1024) return "%.1f KB".format(bytes / 1024.0)
        return "%.1f MB".format(bytes / 1024.0 / 1024.0)
    }
}
