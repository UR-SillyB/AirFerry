package com.airferry.app.scan

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
 *
 * The recovered filename is attacker-controllable (decoded from a scanned QR),
 * so [sanitize] also defends against path traversal: it keeps only the final
 * path component, strips separators and control characters, and removes leading
 * dots so the result can never be `.`/`..`/a hidden traversal name. Call sites
 * that write into a directory should use [uniqueTarget], which additionally
 * verifies the resolved path stays inside that directory.
 */
object FileNameUtil {

    /**
     * Strip characters that are illegal in filenames across common filesystems
     * (slash, backslash, colon, asterisk, question mark, double-quote, angle
     * brackets, pipe, and C0 control characters), reduce to the final path
     * component, and drop leading dots. Spaces, full-width punctuation and all
     * Unicode letters (including CJK extension planes) are kept intact.
     *
     * Never returns blank, `.`, or `..` (falls back to `received_file`).
     * Truncates to 200 chars to stay under filesystem path-component limits.
     */
    fun sanitize(name: String): String {
        // Reduce to the final path component first so an attacker-controlled name
        // can't smuggle directory separators / traversal through; then strip
        // illegal chars and leading dots.
        val base = name.substringAfterLast('/').substringAfterLast('\\')
        val cleaned = base
            .replace(Regex("[/\\\\:*?\"<>|\\p{Cntrl}]"), "_")
            .trim()
            .takeLast(200)
            .trim()
            .trimStart('.')
        return cleaned.ifBlank { "received_file" }
    }

    /**
     * Return a non-existing file in `dir` named `name` (after sanitizing),
     * appending `(1)`, `(2)`, … before the extension on collisions so the
     * original name is never silently overwritten:
     *   报告.docx → 报告.docx
     *   报告.docx (exists) → 报告(1).docx
     *   报告(1).docx (exists) → 报告(2).docx
     *
     * Defensively verifies the resolved path stays inside `dir` (belt-and-
     * suspenders on top of [sanitize]); falls back to a safe name otherwise.
     */
    fun uniqueTarget(dir: File, name: String): File {
        val safe = sanitize(name)
        fun within(f: File): Boolean = try {
            f.canonicalPath.startsWith(dir.canonicalPath + File.separator)
        } catch (_: Exception) {
            false
        }
        val first = File(dir, safe)
        if (!within(first)) return File(dir, "received_file")
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
