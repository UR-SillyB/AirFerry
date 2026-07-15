package com.airferry.app.scan

/**
 * Heuristic: which recovered files should open in the text (copy/share) UI
 * rather than the generic file detail screen.
 *
 * Used for:
 *  - bundle entries (mixed send: "添加文字" → named .txt, plus user-sent docs)
 *  - single-file transfers whose filename looks like plain text
 *  - history re-open when `.meta` has no `kind=text` but the name is text-like
 *
 * Extension-based only (no content sniffing): false positives are limited to
 * misnamed binaries; false negatives just fall back to the file screen.
 * Mirrors Windows `FileNameUtil.IsTextLikeName`.
 */
object TextLike {

    /**
     * Soft cap for opening a recovered file in the text (copy) UI.
     * Larger text-like files fall back to the generic file screen so we do not
     * load multi‑MB logs/JSON into a single String on the UI thread.
     */
    const val MAX_TEXT_UI_BYTES: Int = 2 * 1024 * 1024

    private val EXTENSIONS = setOf(
        // documents / notes
        "txt", "text", "md", "markdown", "rst", "adoc", "asciidoc",
        "csv", "tsv", "log", "nfo", "srt", "vtt", "diff", "patch",
        // structured / config
        "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
        "properties", "env", "plist",
        // web / markup
        "html", "htm", "css", "svg",
        // common source / scripts (often transferred as "text")
        "js", "mjs", "cjs", "ts", "tsx", "jsx",
        "py", "rb", "go", "rs", "java", "kt", "kts", "swift",
        "c", "h", "cpp", "cc", "cxx", "hpp", "cs", "sql", "sh", "bash",
        "zsh", "bat", "cmd", "ps1", "r", "lua", "php",
    )

    fun isTextLikeName(name: String): Boolean {
        val base = name.substringAfterLast('/', name).substringAfterLast('\\')
        val dot = base.lastIndexOf('.')
        if (dot <= 0 || dot >= base.length - 1) return false
        val ext = base.substring(dot + 1).lowercase()
        return ext in EXTENSIONS
    }

    /** True when [size] is small enough for the in-memory text UI. */
    fun fitsTextUi(size: Int): Boolean = size in 0..MAX_TEXT_UI_BYTES

    fun fitsTextUi(size: Long): Boolean = size in 0L..MAX_TEXT_UI_BYTES.toLong()

    /**
     * Decode [bytes] as UTF-8 only if they form a valid UTF-8 sequence.
     * [String] constructor replaces malformed input with U+FFFD; using that
     * for the copy UI would silently corrupt binary files that happen to have
     * a text-like extension. Returns null on invalid UTF-8.
     */
    fun decodeUtf8Strict(bytes: ByteArray): String? {
        if (!fitsTextUi(bytes.size)) return null
        return try {
            val cs = Charsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
            cs.decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        } catch (_: Exception) {
            null
        }
    }
}
