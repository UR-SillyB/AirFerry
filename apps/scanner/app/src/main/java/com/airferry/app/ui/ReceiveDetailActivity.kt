package com.airferry.app.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
import com.airferry.app.scan.CreateNamedDocument
import com.airferry.app.scan.FileTransfer
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

    /**
     * Background thread for the SAF save copy (M6): whole-streaming a blob of
     * up to hundreds of MiB on the main thread (the activity-result callback)
     * is a guaranteed ANR.
     */
    private val saveExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()

    private val createDocument = registerForActivityResult(
        CreateNamedDocument()
    ) { uri: Uri? ->
        if (uri != null) saveToUri(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Keep the screen lit after recovery. ScanActivity forces the screen on
        // with FLAG_KEEP_SCREEN_ON during scanning; without it here the system
        // timeout resumes the instant we land on the result page, so the screen
        // visibly dims/locks right at the moment of success.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

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

    override fun onDestroy() {
        super.onDestroy()
        saveExecutor.shutdown()
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
                    // Only show the CRC row when we actually have a value to
                    // verify. A real "unknown" (no descriptor CRC) shows nothing
                    // rather than a ghost "未知" — the user asked for either a
                    // real verification or no row, never a placeholder.
                    if (!crcUnknown) {
                        DetailRow(
                            "校验",
                            if (crcOk) "CRC32 校验通过" else "校验失败（数据可能损坏）",
                            valueColor = if (crcOk) Success else Error
                        )
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
        val src = recoveredFile ?: return
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
                    Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this, "保存失败: $error", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    /**
     * Share the canonical ContentStore blob via FileProvider (no share/ copy).
     * EXTRA_TITLE carries the original display name for WeChat / QQ / mail.
     */
    private fun shareFile() {
        try {
            val src = recoveredFile ?: return
            if (!src.exists()) {
                Toast.makeText(this, "没有可分享的文件", Toast.LENGTH_SHORT).show()
                return
            }
            // Share the canonical blob without copying, but expose the logical
            // filename: the physical ContentStore path is only a SHA-256 digest.
            val uri = FileTransfer.shareUri(this, src, fileName)
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = FileTransfer.mimeType(fileName)
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_TITLE, FileTransfer.displayName(fileName))
                putExtra(Intent.EXTRA_TEXT, FileTransfer.displayName(fileName))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(shareIntent, "分享文件"))
        } catch (e: Exception) {
            Toast.makeText(this, "分享失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Legacy path: only used when reopening old flows that still pass a
     * non-store temp file without RESAVE. New scans put RESAVE=true after
     * ContentStore.putBytes so this is a no-op for modern transfers.
     */
    private fun copyToReceivedDir() {
        try {
            val src = recoveredFile ?: return
            // Already under ContentStore blobs — nothing to archive.
            val storeRoot = com.airferry.app.scan.ContentStore.root(this).canonicalPath
            if (src.canonicalPath.startsWith(storeRoot)) return

            val put = com.airferry.app.scan.ContentStore.putBytes(
                this, fileName, src.readBytes(),
                crcHex = java.lang.Long.toHexString(
                    ScanActivity.crc32OfBytes(src.readBytes())
                ),
                crcUnknown = false,
                kind = "file",
            )
            recoveredFile = put.path
        } catch (e: Exception) {
            android.util.Log.w("ReceiveDetailActivity", "copyToReceivedDir failed", e)
        }
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
