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
    private var expectedCrc: Int = 0
    private var receivedCrc: Int = 0

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
        expectedCrc = intent.getIntExtra("CRC32", 0)
        receivedCrc = intent.getIntExtra("CRC32_RECEIVED", 0)
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
        val crcOk = expectedCrc == receivedCrc
        val fileExists = recoveredFile?.exists() == true

        Column(
            modifier = Modifier.fillMaxSize().background(BgDark).padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            // Success/check icon
            Box(
                modifier = Modifier.size(96.dp).clip(CircleShape).background(if (crcOk) Success else Error),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    if (crcOk) Icons.Default.Check else Icons.Default.Close,
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
                        if (crcOk) "✓ CRC32 校验通过" else "✗ 校验失败（数据可能损坏）",
                        valueColor = if (crcOk) Success else Error
                    )
                    DetailRow(
                        "期望 CRC32",
                        "0x%08X".format(expectedCrc)
                    )
                    DetailRow(
                        "实际 CRC32",
                        "0x%08X".format(receivedCrc)
                    )
                }
            }

            Spacer(modifier = Modifier.height(24.dp))

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

    private fun copyToReceivedDir() {
        try {
            val src = recoveredFile ?: return
            val dir = File(getExternalFilesDir(null), "received")
            if (!dir.exists()) dir.mkdirs()
            // Use the real filename if available
            val safeName = fileName.takeLast(64).replace(Regex("[^a-zA-Z0-9._-]"), "_")
            val target = File(dir, "${System.currentTimeMillis()}_$safeName")
            src.copyTo(target, overwrite = true)
            // Also write a small metadata sidecar for file size
            File(dir, "${target.name}.meta").writeText("$fileName\n$fileSize\n${java.lang.Integer.toHexString(expectedCrc)}")
        } catch (_: Exception) {}
    }
}
