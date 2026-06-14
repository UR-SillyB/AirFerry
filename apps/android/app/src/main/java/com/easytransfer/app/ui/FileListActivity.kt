package com.easytransfer.app.ui

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
private val DeleteRed = Color(0xFFEF4444)

class FileListActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { FileListScreen() }
    }

    @Composable
    private fun FileListScreen() {
        val dir = remember { File(getExternalFilesDir(null), "received") }
        var fileList by remember {
            mutableStateOf(
                if (dir.exists()) dir.listFiles { f -> !f.name.endsWith(".meta") }
                    ?.sortedByDescending { it.lastModified() }?.toList() ?: emptyList()
                else emptyList()
            )
        }

        Column(modifier = Modifier.fillMaxSize().background(BgDark)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(20.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("已接收文件", color = TextPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                Text("${fileList.size} 个", color = TextSecondary, fontSize = 14.sp)
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
                        FileCard(
                            file = file,
                            onClick = { openFileForResave(file) },
                            onDelete = { deletedFile ->
                                deleteFile(deletedFile)
                                fileList = fileList.filter { it.name != deletedFile.name }
                            }
                        )
                    }
                }
            }

            OutlinedButton(
                onClick = { finish() },
                modifier = Modifier.fillMaxWidth().padding(16.dp).height(50.dp),
                shape = RoundedCornerShape(12.dp)
            ) { Text("返回", color = TextPrimary, fontSize = 16.sp) }
        }
    }

    @Composable
    private fun FileCard(file: File, onClick: () -> Unit, onDelete: (File) -> Unit) {
        val metaFile = remember(file) { File(file.parentFile, "${file.name}.meta") }
        val meta: Triple<String, Long, Int> = remember(file) {
            if (metaFile.exists()) {
                val lines = metaFile.readLines()
                val name = lines.getOrElse(0) { file.name }
                val size = lines.getOrElse(1) { file.length().toString() }.toLongOrNull() ?: file.length()
                val crc = lines.getOrElse(2) { "0" }.toIntOrNull(16) ?: 0
                Triple(name, size, crc)
            } else {
                Triple(file.name, file.length(), 0)
            }
        }
        val origName = meta.first
        val origSize = meta.second
        val origCrc = meta.third

        var showDeleteDialog by remember { mutableStateOf(false) }

        Card(
            modifier = Modifier.fillMaxWidth().clickable { onClick() },
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(containerColor = CardBg)
        ) {
            Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Description, contentDescription = null, tint = Accent, modifier = Modifier.size(32.dp))
                Spacer(modifier = Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(origName, color = TextPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                    val dateStr = java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault()).format(java.util.Date(file.lastModified()))
                    Text("${ScanActivity.formatSize(origSize)} · $dateStr", color = TextSecondary, fontSize = 12.sp)
                }
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

        if (showDeleteDialog) {
            AlertDialog(
                onDismissRequest = { showDeleteDialog = false },
                title = { Text("删除文件") },
                text = { Text("确定删除「$origName」？此操作不可撤销。") },
                confirmButton = {
                    TextButton(onClick = {
                        showDeleteDialog = false
                        onDelete(file)
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

    private fun openFileForResave(file: File) {
        val metaFile = File(file.parentFile, "${file.name}.meta")
        var fileName = file.name
        var fileSize = file.length()
        var crc32 = 0
        if (metaFile.exists()) {
            val lines = metaFile.readLines()
            fileName = lines.getOrElse(0) { file.name }
            fileSize = lines.getOrElse(1) { file.length().toString() }.toLongOrNull() ?: file.length()
            crc32 = lines.getOrElse(2) { "0" }.toIntOrNull(16) ?: 0
        }
        val intent = Intent(this, ReceiveDetailActivity::class.java).apply {
            putExtra("FILE_PATH", file.absolutePath)
            putExtra("FILE_NAME", fileName)
            putExtra("FILE_SIZE", fileSize)
            putExtra("CRC32", crc32)
            putExtra("CRC32_RECEIVED", crc32)
            // Re-save path: don't copy into received/ again (avoids duplicates).
            putExtra("RESAVE", true)
        }
        startActivity(intent)
    }

    private fun deleteFile(file: File) {
        val metaFile = File(file.parentFile, "${file.name}.meta")
        file.delete()
        metaFile.delete()
        Toast.makeText(this, "已删除", Toast.LENGTH_SHORT).show()
    }
}
