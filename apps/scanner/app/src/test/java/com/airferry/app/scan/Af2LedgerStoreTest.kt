package com.airferry.app.scan

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * §12 crash-gap tests for the JSONL resume journal (plan E2): atomic header,
 * commit/invalidate ordering, torn-tail tolerance, and headerless rejection.
 * Invariant under test: the journal never reports MORE completed chunks than
 * reached the disk ("账本完成 ⇒ 数据已落盘" is the caller's ordering rule).
 */
class Af2LedgerStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val root = ByteArray(26) { 0xAF.toByte() } // stand-in ROOT frame bytes

    @Test
    fun createWritesHeaderAtomically() {
        val store = Af2LedgerStore.create(tmp.root, "tid-a", 8192, root)
        assertEquals("tid-a", store.transferIdHex)
        assertEquals(8192, store.chunkRawSize)
        assertArrayEquals(root, store.rootFrameBytes)
        // Reload from disk as a fresh process would.
        val reloaded = Af2LedgerStore.loadMostRecent(tmp.root)!!
        assertEquals("tid-a", reloaded.transferIdHex)
        assertEquals(8192, reloaded.chunkRawSize)
        assertArrayEquals(root, reloaded.rootFrameBytes)
    }

    @Test
    fun commitInvalidateRoundTrip() {
        val store = Af2LedgerStore.create(tmp.root, "tid-b", 8192, root)
        store.commit(2)
        store.commit(5)
        store.commit(9)
        store.invalidate(5)
        val reloaded = Af2LedgerStore.loadMostRecent(tmp.root)!!
        assertArrayEquals(intArrayOf(2, 9), reloaded.completedIndices)
    }

    @Test
    fun tornTailLineIsSkipped() {
        // Crash mid-append: the last line is a partial JSON fragment. It must
        // be skipped so the journal never reports more than reached the disk.
        val store = Af2LedgerStore.create(tmp.root, "tid-c", 8192, root)
        store.commit(1)
        store.commit(3)
        File(tmp.root, "af2-tid-c.ledger.jsonl").appendText("{\"c\":")
        val reloaded = Af2LedgerStore.loadMostRecent(tmp.root)!!
        assertArrayEquals(intArrayOf(1, 3), reloaded.completedIndices)
    }

    @Test
    fun headerlessJournalIsRejected() {
        // Crash before the atomic header rename: a journal with commit lines
        // but no header must not be accepted as a resume source.
        File(tmp.root, "af2-tid-d.ledger.jsonl").writeText("{\"c\":0}\n")
        assertNull(Af2LedgerStore.loadMostRecent(tmp.root))
    }

    @Test
    fun tmpHeaderLeftoverIsIgnored() {
        // Crash between temp write and rename leaves `<name>.ledger.jsonl.tmp`;
        // loadMostRecent only considers the real `.ledger.jsonl` suffix.
        File(tmp.root, "af2-tid-e.ledger.jsonl.tmp").writeText("{\"v\":1}\n")
        assertNull(Af2LedgerStore.loadMostRecent(tmp.root))
    }

    @Test
    fun corruptNewestJournalFallsBackToOlderValidOne() {
        val old = Af2LedgerStore.create(tmp.root, "tid-old", 8192, root)
        old.commit(1)
        File(tmp.root, "af2-tid-old.ledger.jsonl").setLastModified(1_000L)
        val corrupt = File(tmp.root, "af2-tid-new.ledger.jsonl")
        corrupt.writeText("not-json\n")
        corrupt.setLastModified(2_000L)

        val loaded = Af2LedgerStore.loadMostRecent(tmp.root)!!
        assertEquals("tid-old", loaded.transferIdHex)
        assertArrayEquals(intArrayOf(1), loaded.completedIndices)
    }

    @Test
    fun orphanSweepKeepsOnlyPartialsReferencedByValidLedgers() {
        Af2LedgerStore.create(tmp.root, "tid-live", 8192, root)
        val live = File(tmp.root, "af2-tid-live.partial").apply { writeBytes(byteArrayOf(1)) }
        val orphan = File(tmp.root, "af2-tid-orphan.partial").apply { writeBytes(byteArrayOf(2)) }
        val badJournal = File(tmp.root, "af2-tid-bad.ledger.jsonl").apply { writeText("bad") }
        val badPartial = File(tmp.root, "af2-tid-bad.partial").apply { writeBytes(byteArrayOf(3)) }

        Af2LedgerStore.sweepOrphanPartials(tmp.root)

        assertTrue(live.exists())
        assertFalse(orphan.exists())
        assertFalse(badJournal.exists())
        assertFalse(badPartial.exists())
    }
}
