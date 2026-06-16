package com.easytransfer.app.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
private val Success = Color(0xFF22C55E)
private val Error = Color(0xFFEF4444)

class ReceiveDetailActivity : ComponentActivity() {

    private var recoveredFile: File? = null
    private var fileName: String = "received_file"
    private var fileSize: Long = 0L
    /** CRC32 values carried as unsigned 32-bit in a Long (0..=0xFFFFFFFF). */
    private var expectedCrc: Long = 0L
    private var receivedCrc: Long = 0L
    /** True when the descriptor never supplied an expected CRC (so 0 is not a real value). */
    private var crcUnknown: Boolean = true

    private val createDocument = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream")
    ) { uri: Uri? ->
        if (uri != null) saveToUri(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val filePath = intent.getStringExtra("FILE_PATH")
        fileName = intent.getStringExtra("FILE_NAME") ?: "received_file"
        fileSize = intent.getLongExtra("FILE_SIZE", 0L)
        // CRC extras may arrive as Long (new path, ScanActivity) or Int (old
        // path, FileListActivity reads from .meta hex). Read Long first; if the
        // intent only carried an Int, getIntExtra returns the same bits which
        // we reinterpret as unsigned.
        expectedCrc = readCrcExtra(intent, "CRC32")
        receivedCrc = readCrcExtra(intent, "CRC32_RECEIVED")
        crcUnknown = intent.getBooleanExtra("CRC32_UNKNOWN", true)
        recoveredFile = filePath?.let { File(it) }

        // Copy to received dir for file list — but ONLY when arriving from a
        // fresh scan. When re-opened from the file list (RESAVE=true) the file
        // is already in received/, so copying again would create a duplicate.
        val isResave = intent.getBooleanExtra("RESAVE", false)
        if (!isResave) copyToReceivedDir()

        setContent { ReceiveDetailScreen() }
    }

    @Composable
    private fun ReceiveDetailScreen() {
        // crcOk is only meaningful when we actually have an expected CRC.
        // When crcUnknown is true the descriptor never supplied one, so we
        // can neither pass nor fail the file — treat it as neutral.
        val crcOk = !crcUnknown && expectedCrc == receivedCrc
        val fileExists = recoveredFile?.exists() == true

        Column(
            modifier = Modifier.fillMaxSize().background(BgDark).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            // Success/check icon. Unknown CRC is shown as success (file was
            // recovered); only a real mismatch is shown as an error.
            val statusOk = fileExists && (crcOk || crcUnknown)
            Box(
                modifier = Modifier.size(96.dp).clip(CircleShape).background(if (statusOk) Success else Error),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    if (statusOk) Icons.Default.Check else Icons.Default.Close,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(48.dp)
                )
            }

            Spacer(modifier = Modifier.height(24.dp))

            Text(
                if (fileExists) "文件恢复成功" else "文件数据不可用",
                color = TextPrimary, fontSize = 24.sp, fontWeight = FontWeight.Bold
            )

            Spacer(modifier = Modifier.height(16.dp))

            // File info card
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg)
            ) {
                Column(modifier = Modifier.padding(20.dp)) {
                    DetailRow("文件名", fileName)
                    DetailRow("大小", ScanActivity.formatSize(fileSize))
                    DetailRow(
                        "校验",
                        when {
                            crcUnknown -> "— CRC32 未知（未收到描述符）"
                            crcOk -> "✓ CRC32 校验通过"
                            else -> "✗ 校验失败（数据可能损坏）"
                        },
                        valueColor = when {
                            crcUnknown -> TextSecondary
                            crcOk -> Success
                            else -> Error
                        }
                    )
                    if (!crcUnknown) {
                        DetailRow("期望 CRC32", "0x%08X".format(expectedCrc))
                        DetailRow("实际 CRC32", "0x%08X".format(receivedCrc))
                    }
                }
            }

            Spacer(modifier = Modifier.height(24.dp))

            // Share button — share the recovered file directly without saving
            Button(
                onClick = {
                    if (fileExists) {
                        shareFile()
                    } else {
                        Toast.makeText(this@ReceiveDetailActivity, "没有可分享的文件", Toast.LENGTH_SHORT).show()
                    }
                },
                modifier = Modifier.fillMaxWidth().height(50.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Success),
                shape = RoundedCornerShape(12.dp)
            ) {
                Icon(Icons.Default.Share, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("分享", fontSize = 16.sp)
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Save button
            Button(
                onClick = {
                    if (fileExists) {
                        createDocument.launch(fileName)
                    } else {
                        Toast.makeText(this@ReceiveDetailActivity, "没有可保存的文件", Toast.LENGTH_SHORT).show()
                    }
                },
                modifier = Modifier.fillMaxWidth().height(50.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("保存到…", fontSize = 16.sp)
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Back to scan button
            OutlinedButton(
                onClick = { finish() },
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("重新扫码", color = TextPrimary, fontSize = 16.sp)
            }
        }
    }

    @Composable
    private fun DetailRow(label: String, value: String, valueColor: Color = TextPrimary) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(label, color = TextSecondary, fontSize = 14.sp)
            Text(value, color = valueColor, fontSize = 14.sp, fontWeight = FontWeight.Medium)
        }
    }

    private fun saveToUri(uri: Uri) {
        try {
            val src = recoveredFile ?: return
            contentResolver.openOutputStream(uri)?.use { out ->
                src.inputStream().use { it.copyTo(out) }
            }
            Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "保存失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Share the recovered file directly via ACTION_SEND without requiring
     * the user to save it first.  Copies the temp file (recovered_*.<ext>)
     * to a correctly-named file so the share target sees the real filename,
     * then uses FileProvider to securely expose it.
     *
     * EXTRA_TITLE carries the *original* filename (with spaces / Chinese
     * intact) so receiving apps (WeChat / QQ / mail) that derive their
     * display name from this field show it correctly.
     */
    private fun shareFile() {
        try {
            val src = recoveredFile ?: return
            // Copy to a correctly-named file so the receiving app shows the
            // real filename (spaces + CJK preserved) instead of a temp name.
            val safeName = com.easytransfer.app.scan.FileNameUtil.sanitize(fileName)
            val shareDir = File(cacheDir, "share")
            if (!shareDir.exists()) shareDir.mkdirs()
            val shareFile = com.easytransfer.app.scan.FileNameUtil.uniqueTarget(shareDir, safeName)
            src.copyTo(shareFile, overwrite = true)

            val authority = "${packageName}.fileprovider"
            val uri = FileProvider.getUriForFile(this, authority, shareFile)
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "application/octet-stream"
                putExtra(Intent.EXTRA_STREAM, uri)
                // Original name (un-sanitized) as the display title — keeps
                // Chinese + spaces for apps that read EXTRA_TITLE.
                putExtra(Intent.EXTRA_TITLE, fileName)
                putExtra(Intent.EXTRA_TEXT, fileName)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(shareIntent, "分享文件"))
        } catch (e: Exception) {
            Toast.makeText(this, "分享失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun copyToReceivedDir() {
        try {
            val src = recoveredFile ?: return
            val dir = File(getExternalFilesDir(null), "received")
            if (!dir.exists()) dir.mkdirs()
            // Use the real filename (no timestamp prefix); dedupe with (1)(2)
            // on collision so the on-disk name matches what the user sent.
            val target = com.easytransfer.app.scan.FileNameUtil.uniqueTarget(dir, fileName)
            src.copyTo(target, overwrite = true)
            // Also write a small metadata sidecar for file size + crc.
            // Write "unknown" when no expected CRC was supplied so the file
            // list does not display a misleading "0x0".
            val crcStr = if (crcUnknown) "unknown" else java.lang.Long.toHexString(expectedCrc)
            // Line 4: whether the CRC is unknown, so the re-open path can
            // restore the crcUnknown flag instead of treating 0 as verified.
            File(dir, "${target.name}.meta").writeText("$fileName\n$fileSize\n$crcStr\n$crcUnknown")
        } catch (_: Exception) {}
    }

    /**
     * Read a CRC32 intent extra as an unsigned 32-bit Long. Accepts both the
     * new Long encoding (ScanActivity) and the legacy Int encoding, so the
     * detail screen stays compatible with both call sites.
     */
    private fun readCrcExtra(intent: android.content.Intent, key: String): Long {
        // Long extra takes precedence; if absent, fall back to Int (reinterpreted
        // as unsigned 32-bit so high-bit CRC values survive).
        return try {
            val asLong = intent.getLongExtra(key, -1L)
            if (asLong >= 0) asLong else intent.getIntExtra(key, 0).toLong() and 0xFFFFFFFFL
        } catch (_: Exception) {
            intent.getIntExtra(key, 0).toLong() and 0xFFFFFFFFL
        }
    }
}
