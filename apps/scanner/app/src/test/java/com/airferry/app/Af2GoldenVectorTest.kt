package com.airferry.app

import com.airferry.app.scan.ReceiverSessionManager
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.File

/**
 * AF2 cross-platform golden-vector assertions (Kotlin / Android side).
 * Reads `core/testdata/af2/manifest.json` and verifies AF2 frame header parsing.
 */
class Af2GoldenVectorTest {

    private fun unhex(hex: String): ByteArray {
        val len = hex.length
        val out = ByteArray(len / 2)
        for (i in 0 until len step 2) {
            out[i / 2] = ((Character.digit(hex[i], 16) shl 4) + Character.digit(hex[i + 1], 16)).toByte()
        }
        return out
    }

    private fun loadManifest(): JSONObject {
        var dir: File? = File(System.getProperty("user.dir") ?: ".")
        while (dir != null) {
            val candidate = File(dir, "core/testdata/af2/manifest.json")
            if (candidate.isFile) {
                return JSONObject(candidate.readText())
            }
            dir = dir.parentFile
        }
        throw IllegalStateException("core/testdata/af2/manifest.json not found above working directory")
    }

    private data class ParsedHeader(
        val magic: Int,
        val version: Int,
        val flags: Int,
        val sbn: Int,
        val esi: Long
    )

    private fun parseWireHeader(bytes: ByteArray): ParsedHeader? {
        if (bytes.size < 30) return null
        val magic = ((bytes[0].toInt() and 0xFF) shl 8) or (bytes[1].toInt() and 0xFF)
        val version = bytes[2].toInt() and 0xFF
        val flags = bytes[3].toInt() and 0xFF
        val sbn = bytes[22].toInt() and 0xFF
        val esi = ((bytes[23].toLong() and 0xFF) shl 16) or
                ((bytes[24].toLong() and 0xFF) shl 8) or
                (bytes[25].toLong() and 0xFF)
        return ParsedHeader(magic, version, flags, sbn, esi)
    }

    @Test
    fun af2GoldenVectors_verifyHeaders() {
        val manifest = loadManifest()

        // 1. Verify ROOT frame header
        val rootFrameBytes = unhex(manifest.getString("root_frame_hex"))
        val rootHeader = parseWireHeader(rootFrameBytes)
        assertNotNull(rootHeader)
        assertEquals(ReceiverSessionManager.MAGIC, rootHeader!!.magic)
        assertEquals(ReceiverSessionManager.PROTOCOL_VERSION, rootHeader.version)
        assertEquals(1, rootHeader.flags) // FrameTypeRoot = 1

        // 2. Verify OBJECT_META frame header
        val metaFrameBytes = unhex(manifest.getString("object_meta_frame_hex"))
        val metaHeader = parseWireHeader(metaFrameBytes)
        assertNotNull(metaHeader)
        assertEquals(2, metaHeader!!.flags) // FrameTypeObjectMeta = 2

        // 3. Verify SYMBOL frame header
        val symbolFrameBytes = unhex(manifest.getString("symbol_frame_hex"))
        val symbolHeader = parseWireHeader(symbolFrameBytes)
        assertNotNull(symbolHeader)
        assertEquals(3, symbolHeader!!.flags) // FrameTypeSymbol = 3
        assertEquals(1, symbolHeader.sbn)
        assertEquals(42, symbolHeader.esi)
    }
}
