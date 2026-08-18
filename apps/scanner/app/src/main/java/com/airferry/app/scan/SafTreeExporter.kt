package com.airferry.app.scan

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File

/**
 * Export logical bundle paths into one Storage Access Framework tree.
 *
 * ContentStore keeps bundle member names as sanitized `/`-separated relative
 * paths. ACTION_CREATE_DOCUMENT cannot represent that hierarchy, so bundle
 * "save all" uses ACTION_OPEN_DOCUMENT_TREE and materializes each component
 * beneath the selected directory without ever allowing traversal.
 */
object SafTreeExporter {
    data class Item(val source: File, val relativePath: String)

    fun copyAll(context: Context, treeUri: Uri, items: List<Item>): Int {
        if (items.isEmpty()) return 0
        val resolver = context.contentResolver
        val rootId = DocumentsContract.getTreeDocumentId(treeUri)
        val root = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootId)
        val directoryCache = hashMapOf("" to root)
        var copied = 0

        for (item in items) {
            require(item.source.isFile) { "源文件不可用: ${item.relativePath}" }
            val safePath = FileNameUtil.sanitizeRelativePath(item.relativePath)
            val components = safePath.split('/').filter { it.isNotBlank() }
            require(components.isNotEmpty()) { "文件路径为空" }

            var parent = root
            var cacheKey = ""
            for (component in components.dropLast(1)) {
                cacheKey = if (cacheKey.isEmpty()) component else "$cacheKey/$component"
                parent = directoryCache[cacheKey] ?: findOrCreateDirectory(
                    context, treeUri, parent, component
                ).also { directoryCache[cacheKey] = it }
            }

            val leaf = uniqueLeafName(context, treeUri, parent, components.last())
            val target = DocumentsContract.createDocument(
                resolver,
                parent,
                FileTransfer.mimeType(leaf),
                leaf,
            ) ?: throw java.io.IOException("无法创建文件: $safePath")
            try {
                val out = resolver.openOutputStream(target, "w")
                    ?: throw java.io.IOException("无法写入文件: $safePath")
                out.use { output ->
                    item.source.inputStream().use { input -> input.copyTo(output, 1024 * 1024) }
                }
            } catch (e: Exception) {
                // Do not leave a zero/partial file behind when a provider or
                // source read fails midway through one member.
                try { DocumentsContract.deleteDocument(resolver, target) } catch (_: Exception) {}
                throw e
            }
            copied++
        }
        return copied
    }

    private fun findOrCreateDirectory(
        context: Context,
        treeUri: Uri,
        parent: Uri,
        name: String,
    ): Uri {
        findChild(context, treeUri, parent, name)?.let { (uri, mime) ->
            if (mime != DocumentsContract.Document.MIME_TYPE_DIR) {
                throw java.io.IOException("目标中已有同名文件，无法创建目录: $name")
            }
            return uri
        }
        return DocumentsContract.createDocument(
            context.contentResolver,
            parent,
            DocumentsContract.Document.MIME_TYPE_DIR,
            name,
        ) ?: throw java.io.IOException("无法创建目录: $name")
    }

    private fun uniqueLeafName(
        context: Context,
        treeUri: Uri,
        parent: Uri,
        requested: String,
    ): String {
        if (findChild(context, treeUri, parent, requested) == null) return requested
        val dot = requested.lastIndexOf('.')
        val base = if (dot > 0) requested.substring(0, dot) else requested
        val ext = if (dot > 0) requested.substring(dot) else ""
        var n = 1
        while (n < 10_000) {
            val candidate = "$base ($n)$ext"
            if (findChild(context, treeUri, parent, candidate) == null) return candidate
            n++
        }
        throw java.io.IOException("目标目录同名文件过多: $requested")
    }

    private fun findChild(
        context: Context,
        treeUri: Uri,
        parent: Uri,
        name: String,
    ): Pair<Uri, String>? {
        val resolver = context.contentResolver
        val parentId = DocumentsContract.getDocumentId(parent)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
        )
        resolver.query(children, projection, null, null, null)?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val nameCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            val mimeCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
            while (cursor.moveToNext()) {
                if (cursor.getString(nameCol) == name) {
                    val id = cursor.getString(idCol)
                    val mime = cursor.getString(mimeCol)
                    return DocumentsContract.buildDocumentUriUsingTree(treeUri, id) to mime
                }
            }
        }
        return null
    }
}
