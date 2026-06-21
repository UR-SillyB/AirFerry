package com.airferry.app.ui

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

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
        val prefs = remember { getSharedPreferences("airferry", MODE_PRIVATE) }
        var redundancy by remember { mutableFloatStateOf(prefs.getInt("default_redundancy", 5).toFloat()) }

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
                }
            }

            Card(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = CardBg)
            ) {
                Column(modifier = Modifier.padding(20.dp)) {
                    Text("易传 AirFerry", color = TextPrimary, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    Text("版本 ${appVersionName()}", color = TextSecondary, fontSize = 13.sp)
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
