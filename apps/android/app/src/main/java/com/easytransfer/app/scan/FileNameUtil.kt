package com.easytransfer.app.scan

import java.io.File

/**
 * Filename helpers shared by the receive / detail / bundle activities.
 *
 * Historically each activity had its own copy of a "sanitize" regex that
 * aggressively stripped everything except ASCII alphanumerics and the CJK
 * Unified Ideographs basic block (U+4E00..U+9FFF). That mangled real-world
 * names — spaces, full-width punctuation (（）), CJK extension characters and
 * most symbols were all replaced with `_`, so a name like `报告 2024.docx`
 * became `报告_2024.docx` and Chinese filenames frequently failed to carry
 * through to share targets (WeChat / QQ / mail clients derive the display
 * name from the FileProvider URI, which used the mangled disk name).
 *
 * Android filesystems (and the SAF) accept a wide range of characters; only
 * a handful are genuinely illegal across filesystems. These helpers strip
 * *only* those, preserving spaces and all CJK characters.
 */
object FileNameUtil {

    /**
     * Strip only characters that are illegal in filenames across common
     * filesystems: forward slash, backslash, colon, asterisk, question mark,
     * double-quote, angle brackets, pipe, and C0 control characters
     * (0x00–0x1F). Spaces, full-width punctuation and all Unicode letters
     * (including CJK extension planes) are kept intact.
     *
     * Trims leading/trailing whitespace and collapses the result so it is never
     * empty (falls back to `received_file`). Truncates to 200 chars to stay
     * well under any filesystem path-component limit.
     */
    fun sanitize(name: String): String {
        val cleaned = name.trim()
            .replace(Regex("[/\\\\:*?\"<>|\u0000-\u001F]"), "_")
            .takeLast(200)
            .trim()
        return cleaned.ifBlank { "received_file" }
    }

    /**
     * Return a non-existing file in `dir` named `name` (after sanitizing),
     * appending `(1)`, `(2)`, … before the extension on collisions so the
     * original name is never silently overwritten:
     *   报告.docx → 报告.docx
     *   报告.docx (exists) → 报告(1).docx
     *   报告(1).docx (exists) → 报告(2).docx
     */
    fun uniqueTarget(dir: File, name: String): File {
        val safe = sanitize(name)
        val first = File(dir, safe)
        if (!first.exists()) return first
        val dot = safe.lastIndexOf('.')
        val (base, ext) = if (dot in 1 until safe.length - 1) {
            safe.substring(0, dot) to safe.substring(dot)
        } else {
            safe to ""
        }
        var i = 1
        while (File(dir, "$base($i)$ext").exists()) i++
        return File(dir, "$base($i)$ext")
    }
}
