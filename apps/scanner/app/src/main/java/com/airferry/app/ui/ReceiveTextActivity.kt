package com.airferry.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val BgDark = Color(0xFF0F172A)
private val CardBg = Color(0xFF1E293B)
private val Accent = Color(0xFF3B82F6)
private val TextPrimary = Color(0xFFF1F5F9)
private val TextSecondary = Color(0xFF94A3B8)
private val Success = Color(0xFF22C55E)
private val Error = Color(0xFFEF4444)

/**
 * Result screen for a recovered TEXT transfer (ETTEXTv1 payload).
 *
 * Mirrors [ReceiveDetailActivity]'s layout (status icon + info card + action
 * buttons) but the "content" is an in-memory string, not a file on disk. The
 * user can copy the text to the clipboard, share it as `text/plain`, or save
 * it as a `.txt`. CRC verification is shown the same way as a file.
 *
 * Invoked from [com.airferry.app.ui.ScanActivity.recoverAndStage] with intent
 * extras: `TEXT` (String), `CRC32`/`CRC32_RECEIVED`/`CRC32_UNKNOWN`.
 */
class ReceiveTextActivity : ComponentActivity() {

    private var text: String = ""
    /** CRC32 values carried as unsigned 32-bit in a Long (0..=0xFFFFFFFF). */
    private var expectedCrc: Long = 0L
    private var receivedCrc: Long = 0L
    /** True when the descriptor never supplied an expected CRC. */
    private var crcUnknown: Boolean = true
    /** Suggested .txt name when saving (bundle entry name, or default). */
    private var saveFileName: String = "文字消息.txt"

    private val createDocument = registerForActivityResult(
        ActivityResultContracts.CreateDocument("text/plain")
    ) { uri: Uri? ->
        if (uri != null) saveToUri(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        text = intent.getStringExtra("TEXT") ?: ""
        expectedCrc = readCrcExtra(intent, "CRC32")
        receivedCrc = readCrcExtra(intent, "CRC32_RECEIVED")
        crcUnknown = intent.getBooleanExtra("CRC32_UNKNOWN", true)
        // Optional display name (e.g. when opened from a bundle .txt entry).
        val named = intent.getStringExtra("FILE_NAME")?.trim().orEmpty()
        if (named.isNotEmpty()) {
            saveFileName = if (named.endsWith(".txt", ignoreCase = true)) named else "$named.txt"
        }

        setContent { ReceiveTextScreen() }
    }

    @Composable
    private fun ReceiveTextScreen() {
        // crcOk is only meaningful when we actually have an expected CRC.
        val crcOk = !crcUnknown && expectedCrc == receivedCrc
        val hasText = text.isNotEmpty()
        val statusOk = hasText && (crcOk || crcUnknown)
        val charCount = remember(text) { text.length }

        Column(
            modifier = Modifier.fillMaxSize().background(BgDark).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
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
                if (hasText) "文字接收成功" else "文字数据不可用",
                color = TextPrimary, fontSize = 24.sp, fontWeight = FontWeight.Bold
            )

            Spacer(modifier = Modifier.height(16.dp))

            // Scrollable text content card.
            Card(
                modifier = Modifier.fillMaxWidth().weight(1f, fill = true),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg)
            ) {
                Text(
                    text = text,
                    color = TextPrimary,
                    fontSize = 15.sp,
                    modifier = Modifier
                        .padding(16.dp)
                        .verticalScroll(rememberScrollState())
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            // CRC info card (compact).
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    DetailRow("字数", "$charCount 字")
                    // Only show the CRC row when we actually have a value to
                    // verify — a real "unknown" shows nothing rather than a
                    // ghost "未知" (user asked for either a real verification
                    // or no row).
                    if (!crcUnknown) {
                        DetailRow(
                            "校验",
                            if (crcOk) "✓ CRC32 校验通过" else "✗ 校验失败（数据可能损坏）",
                            valueColor = if (crcOk) Success else Error
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Copy button — the primary action for a text transfer.
            Button(
                onClick = {
                    if (hasText) {
                        copyToClipboard()
                        Toast.makeText(this@ReceiveTextActivity, "已复制到剪贴板", Toast.LENGTH_SHORT).show()
                    }
                },
                modifier = Modifier.fillMaxWidth().height(50.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Success),
                shape = RoundedCornerShape(12.dp)
            ) {
                Icon(Icons.Default.ContentCopy, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("复制文字", fontSize = 16.sp)
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Share as text/plain (EXTRA_TEXT = the actual content, not a file).
            Button(
                onClick = {
                    if (hasText) shareText()
                },
                modifier = Modifier.fillMaxWidth().height(50.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Accent),
                shape = RoundedCornerShape(12.dp)
            ) {
                Icon(Icons.Default.Share, contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text("分享", fontSize = 16.sp)
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Save as .txt via SAF.
            Button(
                onClick = {
                    if (hasText) createDocument.launch(saveFileName)
                },
                modifier = Modifier.fillMaxWidth().height(50.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF6366F1)),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("保存为 .txt", fontSize = 16.sp)
            }

            Spacer(modifier = Modifier.height(12.dp))

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

    /** Copy the recovered text to the system clipboard. */
    private fun copyToClipboard() {
        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        // Label is clip metadata only; keep it neutral so paste/share targets never
        // prepend branding as a fake "first line" of the document.
        clipboard.setPrimaryClip(ClipData.newPlainText("", text))
    }

    /** Share the text via ACTION_SEND with type text/plain and EXTRA_TEXT only. */
    private fun shareText() {
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }
        startActivity(Intent.createChooser(shareIntent, "分享文字"))
    }

    /** Write the text to a SAF-chosen Uri as UTF-8. */
    private fun saveToUri(uri: Uri) {
        try {
            contentResolver.openOutputStream(uri)?.use { out ->
                out.write(text.toByteArray(Charsets.UTF_8))
            }
            Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "保存失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * Read a CRC32 intent extra as an unsigned 32-bit Long. Accepts both Long
     * and legacy Int encodings (mirrors [ReceiveDetailActivity.readCrcExtra]).
     */
    private fun readCrcExtra(intent: android.content.Intent, key: String): Long {
        return try {
            val asLong = intent.getLongExtra(key, -1L)
            if (asLong >= 0) asLong else intent.getIntExtra(key, 0).toLong() and 0xFFFFFFFFL
        } catch (_: Exception) {
            intent.getIntExtra(key, 0).toLong() and 0xFFFFFFFFL
        }
    }
}
