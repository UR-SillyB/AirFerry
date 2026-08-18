package com.airferry.app.scan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FileNameUtilTest {
    @Test
    fun removesTraversalAndIllegalCharactersButKeepsUnicode() {
        assertEquals("报告 2026（终稿）.txt", FileNameUtil.sanitize("../../报告 2026（终稿）.txt"))
        assertEquals("a_b_c_.txt", FileNameUtil.sanitize("a:b?c*.txt"))
        assertEquals("received_file", FileNameUtil.sanitize("../.."))
    }

    @Test
    fun truncationNeverSplitsSurrogatePairs() {
        // 201 'A' + one emoji (surrogate pair): the cut at 200 chars would
        // otherwise leave an orphan high surrogate at the end — assert the
        // result is well-formed (no dangling surrogates) and 200 chars.
        val name = "A".repeat(201) + "😀"
        val sanitized = FileNameUtil.sanitize(name)
        assertEquals(200, sanitized.length)
        assertFalse(Character.isHighSurrogate(sanitized.last()))
    }

    @Test
    fun truncationDropsOrphanLowSurrogateAtCut() {
        // 199 'A' + emoji(2 chars) + 'Z': takeLast(200) would start at the
        // emoji's low surrogate; the sanitizer must skip it instead.
        val name = "A".repeat(199) + "😀" + "Z"
        val sanitized = FileNameUtil.sanitize(name)
        assertFalse(Character.isLowSurrogate(sanitized.first()))
        assertTrue(sanitized.endsWith("Z"))
    }

    @Test
    fun relativePathSanitizationPreservesHierarchyWithoutTraversal() {
        assertEquals(
            "目录/子目录/报告 2026.txt",
            FileNameUtil.sanitizeRelativePath("目录/子目录/报告 2026.txt"),
        )
        assertEquals(
            "escape/a_b.txt",
            FileNameUtil.sanitizeRelativePath("../escape/a:b.txt"),
        )
    }
}
