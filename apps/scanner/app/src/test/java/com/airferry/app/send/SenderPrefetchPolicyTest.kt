package com.airferry.app.send

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SenderPrefetchPolicyTest {
    @Test
    fun bootstrapAndInvalidPositionsDoNotPrefetch() {
        assertNull(nextPrefetchChunk(-1, 4))
        assertNull(nextPrefetchChunk(0, 0))
        assertNull(nextPrefetchChunk(4, 4))
    }

    @Test
    fun onlyNextWindowIsPrefetchedIncludingEpochWrap() {
        assertEquals(1, nextPrefetchChunk(0, 4))
        assertEquals(3, nextPrefetchChunk(2, 4))
        assertEquals(0, nextPrefetchChunk(3, 4))
        assertEquals(0, nextPrefetchChunk(0, 1))
    }

    @Test
    fun stagedSlotsStayBoundedAcrossMultipleEpochs() {
        for (chunkCount in listOf(1, 2, 4, 1024)) {
            val staged = mutableSetOf<Int>()
            repeat(3) {
                for (current in 0 until chunkCount) {
                    // Building the current encoder consumes its staged slot;
                    // retiring the encoder deliberately preserves other slots.
                    staged.remove(current)
                    repeat(5) {
                        nextPrefetchChunk(current, chunkCount)?.let { staged.add(it) }
                    }
                    assertTrue("count=$chunkCount current=$current staged=$staged", staged.size <= 1)
                    assertEquals(setOf((current + 1) % chunkCount), staged)
                }
            }
        }
    }
}
