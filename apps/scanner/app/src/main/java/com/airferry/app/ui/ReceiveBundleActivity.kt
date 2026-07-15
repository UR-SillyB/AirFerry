package com.airferry.app.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.core.content.FileProvider
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
 * Lists every unpacked file with its size, and lets the user save the whole
 * batch (one SAF dialog per file, in order) or share the entire set via
 * ACTION_SEND_MULTIPLE. Reached from [ScanActivity] when the recovered payload
 * carries the bundle magic.
 *
 * Files are passed via three parallel string-array extras ("FILE_PATHS",
 * "FILE_NAMES", "FILE_SIZES") rather than a Parcelable to avoid adding the
 * kotlin-parcelize plugin to the build.
 */
class ReceiveBundleActivity : ComponentActivity() {

    /** One unpacked file: temp path + original name + size. */
    data class FileInfo(
        val filePath: String,
        val name: String,
        val size: Long
    )

    private val files = mutableStateListOf<FileInfo>()
    private var expectedCrc: Long = 0L
    private var receivedCrc: Long = 0L
    private var crcUnknown: Boolean = true

    /** Index of the file we are currently saving in the sequential save-all flow. */
    private var pendingSaveIndex = 0

    private val saveOne = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream")
    ) { uri: Uri? ->
        if (uri != null) {
            saveToUri(uri, files.getOrNull(pendingSaveIndex))
        }
        // Advance to the next file and keep launching SAF dialogs until done.
        advanceSaveAll()
    }

    /**
     * Drive the sequential save-all flow: after each SAF dialog resolves, move
     * to the next file and relaunch. Lives in a normal method (not the
     * registerForActivityResult lambda) so the launcher's type can be inferred
     * without a self-reference recursion.
     */
    private fun advanceSaveAll() {
        pendingSaveIndex++
        if (pendingSaveIndex < files.size) {
            saveOne.launch(files[pendingSaveIndex].name)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
                        crcOk -> "整体校验：✓ CRC32 校验通过"
                        else -> "整体校验：✗ 校验失败（数据可能损坏）"
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
                items(files, key = { it.filePath }) { f ->
                    val looksText = TextLike.isTextLikeName(f.name)
                    FileRow(
                        f = f,
                        looksText = looksText,
                        onOpenText = { openAsText(f) },
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
                            pendingSaveIndex = 0
                            saveOne.launch(files[0].name)
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
        onOpenText: () -> Unit,
        onSave: () -> Unit,
        onShare: () -> Unit,
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .then(if (looksText) Modifier.clickable(onClick = onOpenText) else Modifier),
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = CardBg)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        if (looksText) "📝 ${f.name}" else f.name,
                        color = TextPrimary,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                    )
                    Text(
                        if (looksText) "${formatSize(f.size)} · 点开可复制" else formatSize(f.size),
                        color = TextSecondary,
                        fontSize = 12.sp,
                    )
                }
                if (looksText) {
                    TextButton(onClick = onOpenText) { Text("复制", color = Success, fontSize = 13.sp) }
                }
                TextButton(onClick = onSave) { Text("保存", color = Accent, fontSize = 13.sp) }
                TextButton(onClick = onShare) { Text("分享", color = Success, fontSize = 13.sp) }
            }
        }
    }

    /**
     * Open a bundle entry as a text message (copy / share / save .txt).
     * Used for sender-side "添加文字" items materialised as named .txt files
     * inside ETBUNDL1 — no ETTEXTv1 magic on the wire for mixed batches.
     */
    private fun openAsText(info: FileInfo) {
        val src = File(info.filePath)
        if (!src.exists()) {
            Toast.makeText(this, "文件不可用", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            if (!TextLike.fitsTextUi(src.length())) {
                Toast.makeText(this, "文件过大，请用「保存」后用其他应用打开", Toast.LENGTH_SHORT).show()
                return
            }
            val bytes = src.readBytes()
            val text = TextLike.decodeUtf8Strict(bytes)
            if (text == null) {
                Toast.makeText(this, "该文件不是有效的 UTF-8 文本", Toast.LENGTH_SHORT).show()
                return
            }
            startActivity(
                Intent(this, ReceiveTextActivity::class.java).apply {
                    putExtra("TEXT", text)
                    putExtra("FILE_PATH", info.filePath)
                    putExtra("FILE_NAME", info.name)
                    // Per-entry CRC is not tracked for bundle members; mark unknown.
                    putExtra("CRC32_UNKNOWN", true)
                }
            )
        } catch (e: Exception) {
            Toast.makeText(this, "无法作为文字打开: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }


    private fun saveToUri(uri: Uri, info: FileInfo?) {
        val src = info?.let { File(it.filePath) } ?: return
        try {
            contentResolver.openOutputStream(uri)?.use { out ->
                src.inputStream().use { it.copyTo(out) }
            }
            Toast.makeText(this, "已保存 ${info.name}", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "保存失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /** Share a single file via ACTION_SEND. */
    private fun shareOne(info: FileInfo) {
        val src = File(info.filePath)
        if (!src.exists()) {
            Toast.makeText(this, "文件不可用", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val shareDir = File(cacheDir, "share").also { if (!it.exists()) it.mkdirs() }
            val shareFile = com.airferry.app.scan.FileNameUtil.uniqueTarget(shareDir, info.name)
            src.copyTo(shareFile, overwrite = true)
            val uri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", shareFile)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "application/octet-stream"
                putExtra(Intent.EXTRA_STREAM, uri)
                // Original name (Chinese + spaces intact) for apps that read
                // EXTRA_TITLE / EXTRA_TEXT to derive the display name.
                putExtra(Intent.EXTRA_TITLE, info.name)
                putExtra(Intent.EXTRA_TEXT, info.name)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(intent, "分享 ${info.name}"))
        } catch (e: Exception) {
            Toast.makeText(this, "分享失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /** Share the whole bundle via ACTION_SEND_MULTIPLE. */
    private fun shareAll() {
        try {
            val shareDir = File(cacheDir, "share").also { if (!it.exists()) it.mkdirs() }
            val uris = ArrayList<Uri>()
            val names = ArrayList<String>()
            for (f in files) {
                val src = File(f.filePath)
                if (!src.exists()) continue
                val shareFile = com.airferry.app.scan.FileNameUtil.uniqueTarget(shareDir, f.name)
                src.copyTo(shareFile, overwrite = true)
                uris.add(FileProvider.getUriForFile(this, "${packageName}.fileprovider", shareFile))
                names.add(f.name)
            }
            if (uris.isEmpty()) {
                Toast.makeText(this, "没有可分享的文件", Toast.LENGTH_SHORT).show()
                return
            }
            val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                type = "application/octet-stream"
                putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                // Title: the joined names (or a count) so receiving apps have a
                // display string instead of a raw FileProvider URI slug.
                putExtra(Intent.EXTRA_TITLE, if (names.size == 1) names[0] else "${names.size} 个文件")
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
