using AirFerry.Windows.Scan;
using Xunit;

namespace AirFerry.Windows.Tests;

/// <summary>
/// §12 crash-gap tests for the Windows JSONL resume journal (plan E2):
/// atomic header, commit/invalidate ordering, torn-tail tolerance, and
/// headerless rejection. Invariant under test: the journal never reports
/// MORE completed chunks than reached the disk.
/// </summary>
public class Af2LedgerStoreTests
{
    private static string TempRoot()
    {
        string dir = Path.Combine(Path.GetTempPath(), "AirFerry.Af2LedgerStoreTests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static byte[] RootFrame => Enumerable.Repeat((byte)0xAF, 26).ToArray();

    [Fact]
    public void CreateWritesHeaderAtomically()
    {
        string dir = TempRoot();
        try
        {
            var store = Af2LedgerStore.Create(dir, "tid-a", 8192, RootFrame);
            Assert.Equal("tid-a", store.TransferIdHex);
            Assert.Equal(8192, store.ChunkRawSize);
            Assert.Equal(RootFrame, store.RootFrameBytes);

            // Reload from disk as a fresh process would.
            var reloaded = Af2LedgerStore.LoadMostRecent(dir);
            Assert.NotNull(reloaded);
            Assert.Equal("tid-a", reloaded!.TransferIdHex);
            Assert.Equal(8192, reloaded.ChunkRawSize);
            Assert.Equal(RootFrame, reloaded.RootFrameBytes);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void CommitInvalidateRoundTrip()
    {
        string dir = TempRoot();
        try
        {
            var store = Af2LedgerStore.Create(dir, "tid-b", 8192, RootFrame);
            store.Commit(2);
            store.Commit(5);
            store.Commit(9);
            store.Invalidate(5);

            var reloaded = Af2LedgerStore.LoadMostRecent(dir)!;
            Assert.Equal(new[] { 2, 9 }, reloaded.CompletedIndices);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void TornTailLineIsSkipped()
    {
        string dir = TempRoot();
        try
        {
            var store = Af2LedgerStore.Create(dir, "tid-c", 8192, RootFrame);
            store.Commit(1);
            store.Commit(3);
            // Crash mid-append: a partial JSON fragment at the tail. It must
            // be skipped so the journal never reports more than the disk holds.
            File.AppendAllText(Path.Combine(dir, "af2-tid-c.ledger.jsonl"), "{\"c\":");

            var reloaded = Af2LedgerStore.LoadMostRecent(dir)!;
            Assert.Equal(new[] { 1, 3 }, reloaded.CompletedIndices);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void HeaderlessJournalIsRejected()
    {
        string dir = TempRoot();
        try
        {
            // Crash before the atomic header rename: commit lines without a
            // header must not be accepted as a resume source.
            File.WriteAllText(Path.Combine(dir, "af2-tid-d.ledger.jsonl"), "{\"c\":0}\n");
            Assert.Null(Af2LedgerStore.LoadMostRecent(dir));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void TempHeaderLeftoverIsIgnored()
    {
        string dir = TempRoot();
        try
        {
            // Crash between temp write and rename leaves `<name>.tmp`; the
            // loader only considers the real `.ledger.jsonl` suffix.
            File.WriteAllText(Path.Combine(dir, "af2-tid-e.ledger.jsonl.tmp"), "{\"v\":1}\n");
            Assert.Null(Af2LedgerStore.LoadMostRecent(dir));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void ListPendingTransfersReportsHeaderFields()
    {
        string dir = TempRoot();
        try
        {
            var store = Af2LedgerStore.Create(dir, "tid-f", 8 * 1024 * 1024, RootFrame);
            store.Commit(0);
            store.Commit(1);

            var pending = Af2LedgerStore.ListPendingTransfers(dir);
            Af2LedgerStore.PendingTransfer entry = Assert.Single(pending);
            Assert.Equal("tid-f", entry.TransferIdHex);
            Assert.Equal(8 * 1024 * 1024, entry.ChunkRawSize);
            Assert.Equal(2, entry.CompletedCount);
            Assert.True(entry.DiskBytes > 0);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void CorruptNewestJournalFallsBackToOlderValidOne()
    {
        string dir = TempRoot();
        try
        {
            var old = Af2LedgerStore.Create(dir, "tid-old", 8192, RootFrame);
            old.Commit(1);
            File.SetLastWriteTimeUtc(Path.Combine(dir, "af2-tid-old.ledger.jsonl"),
                DateTime.UtcNow.AddMinutes(-2));
            string corrupt = Path.Combine(dir, "af2-tid-new.ledger.jsonl");
            File.WriteAllText(corrupt, "not-json\n");
            File.SetLastWriteTimeUtc(corrupt, DateTime.UtcNow);

            var loaded = Af2LedgerStore.LoadMostRecent(dir);
            Assert.NotNull(loaded);
            Assert.Equal("tid-old", loaded!.TransferIdHex);
            Assert.Equal(new[] { 1 }, loaded.CompletedIndices);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void SweepOrphanPartialsKeepsOnlyValidJournalBackings()
    {
        string dir = TempRoot();
        try
        {
            Af2LedgerStore.Create(dir, "tid-live", 8192, RootFrame);
            string live = Path.Combine(dir, "af2-tid-live.partial");
            string orphan = Path.Combine(dir, "af2-tid-orphan.partial");
            string badJournal = Path.Combine(dir, "af2-tid-bad.ledger.jsonl");
            string badPartial = Path.Combine(dir, "af2-tid-bad.partial");
            File.WriteAllBytes(live, [1]);
            File.WriteAllBytes(orphan, [2]);
            File.WriteAllText(badJournal, "bad");
            File.WriteAllBytes(badPartial, [3]);

            Af2LedgerStore.SweepOrphanPartials(dir);

            Assert.True(File.Exists(live));
            Assert.False(File.Exists(orphan));
            Assert.False(File.Exists(badJournal));
            Assert.False(File.Exists(badPartial));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
