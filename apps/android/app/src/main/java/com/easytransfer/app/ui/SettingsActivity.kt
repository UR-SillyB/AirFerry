package com.easytransfer.app.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.easytransfer.app.scan.HighSpeedCaptureController

private val BgDark = Color(0xFF0F172A)
private val CardBg = Color(0xFF1E293B)
private val Accent = Color(0xFF3B82F6)
private val TextPrimary = Color(0xFFF1F5F9)
private val TextSecondary = Color(0xFF94A3B8)

class SettingsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { SettingsScreen() }
    }

    @Composable
    private fun SettingsScreen() {
        val prefs = remember { getSharedPreferences("easytransfer", MODE_PRIVATE) }
        var redundancy by remember { mutableFloatStateOf(prefs.getInt("default_redundancy", 10).toFloat()) }
        val context = LocalContext.current
        val highSpeedSupported = remember { HighSpeedCaptureController.isSupported(context) }
        var highSpeedMode by remember { mutableStateOf(prefs.getBoolean("highspeed_mode", false)) }
        var multiQrMode by remember { mutableStateOf(prefs.getBoolean("multi_qr_mode", false)) }

        Column(modifier = Modifier.fillMaxSize().background(BgDark)) {
            Text(
                "设置",
                color = TextPrimary, fontSize = 22.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(20.dp)
            )
            HorizontalDivider(color = Color(0xFF334155))

            Card(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg)
            ) {
                Column(modifier = Modifier.padding(20.dp)) {
                    Text("默认冗余率", color = TextSecondary, fontSize = 14.sp)
                    Text("${redundancy.toInt()}%", color = TextPrimary, fontSize = 28.sp, fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.height(8.dp))
                    Slider(
                        value = redundancy,
                        onValueChange = { redundancy = it },
                        onValueChangeFinished = {
                            prefs.edit().putInt("default_redundancy", redundancy.toInt()).apply()
                        },
                        valueRange = 5f..50f,
                        steps = 8,
                        colors = SliderDefaults.colors(thumbColor = Accent, activeTrackColor = Accent)
                    )
                    Text("冗余率越高，抗丢帧能力越强，但传输速度越慢。推荐 10–20%。", color = TextSecondary, fontSize = 12.sp)
                }
            }

            Card(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg)
            ) {
                Column(modifier = Modifier.padding(20.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("实验性：高速相机录制", color = TextPrimary, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                            Text(
                                if (highSpeedSupported)
                                    "用 120/240fps 高速摄像录制后台批量解码。仅旗舰机支持，有损压缩可能降低识别率，失败会自动回退普通模式。"
                                else
                                    "当前设备不支持高速摄像（无 constrained high-speed 能力）。",
                                color = TextSecondary, fontSize = 12.sp
                            )
                        }
                        Spacer(modifier = Modifier.width(12.dp))
                        Switch(
                            checked = highSpeedMode && highSpeedSupported,
                            enabled = highSpeedSupported,
                            onCheckedChange = {
                                highSpeedMode = it
                                prefs.edit().putBoolean("highspeed_mode", it).apply()
                            }
                        )
                    }
                }
            }

            Card(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg)
            ) {
                Column(modifier = Modifier.padding(20.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("实验性：多二维码同屏", color = TextPrimary, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                            Text(
                                "接收端每帧解码屏幕上的全部二维码（而非仅一个），配合发送端「同屏二维码数」可成倍提升吞吐。每个码更小更难扫，需近距离对准。默认关闭。",
                                color = TextSecondary, fontSize = 12.sp
                            )
                        }
                        Spacer(modifier = Modifier.width(12.dp))
                        Switch(
                            checked = multiQrMode,
                            onCheckedChange = {
                                multiQrMode = it
                                prefs.edit().putBoolean("multi_qr_mode", it).apply()
                            },
                            colors = SwitchDefaults.colors(checkedThumbColor = Accent, checkedTrackColor = Accent)
                        )
                    }
                }
            }

            Card(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg)
            ) {
                Column(modifier = Modifier.padding(20.dp)) {
                    Text("关于", color = TextSecondary, fontSize = 14.sp)
                    Spacer(modifier = Modifier.height(8.dp))
                    Text("易传 EasyTransfer", color = TextPrimary, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    Text("版本 ${appVersionName()}", color = TextSecondary, fontSize = 13.sp)
                    Spacer(modifier = Modifier.height(8.dp))
                    Text("完全离线的光学文件传输系统。通过屏幕二维码视频流传输文件，无需网络、蓝牙、USB。", color = TextSecondary, fontSize = 13.sp)
                }
            }

            Spacer(modifier = Modifier.weight(1f))

            OutlinedButton(
                onClick = { finish() },
                modifier = Modifier.fillMaxWidth().padding(16.dp).height(50.dp),
                shape = RoundedCornerShape(12.dp)
            ) { Text("返回", color = TextPrimary, fontSize = 16.sp) }
        }
    }

    /**
     * Read the installed version name from the package manifest (the single
     * source of truth — build.gradle.kts `versionName`). Avoids hardcoding a
     * version string that drifts from the actual build (the previous literal
     * "0.1.0" was wrong ever since the v1.0.0 bump).
     */
    private fun appVersionName(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
    } catch (_: Exception) {
        "?"
    }
}
