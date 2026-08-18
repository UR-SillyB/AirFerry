using AirFerry.Windows.Bundle;
using Xunit;

namespace AirFerry.Windows.Tests;

public class ContinuousSaverTests
{
    private static string TempRoot() =>
        Path.Combine(Path.GetTempPath(), "AirFerry.ContinuousSaverTests",
            Guid.NewGuid().ToString("N"));

    [Fact]
    public void Constructor_EmptyDir_Throws()
    {
        Assert.Throws<ArgumentException>(() => new ContinuousSaver(" "));
    }

    [Fact]
    public void SaveSingle_WritesFileWithSanitizedName()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var report = saver.SaveSingle("报告<>2026.pdf", [1, 2, 3]);

            Assert.Equal(ContinuousSaveStatus.Saved, report.Status);
            Assert.True(File.Exists(Path.Combine(root, "报告__2026.pdf")));
            Assert.Equal(new byte[] { 1, 2, 3 },
                File.ReadAllBytes(Path.Combine(root, "报告__2026.pdf")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveBundle_PreservesRelativeDirectoryHierarchy()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var files = new List<BundleFile>
            {
                new("docs/a.txt", new byte[] { 1 }),
                new("images/raw/b.bin", new byte[] { 2, 3 }),
            };

            var report = saver.SaveBundle(files, title: "包");

            Assert.Equal(ContinuousSaveStatus.Saved, report.Status);
            Assert.Equal(new byte[] { 1 },
                File.ReadAllBytes(Path.Combine(root, "包", "docs", "a.txt")));
            Assert.Equal(new byte[] { 2, 3 },
                File.ReadAllBytes(Path.Combine(root, "包", "images", "raw", "b.bin")));

            // Marker verification must also understand relative member paths,
            // otherwise a replay after restart would save a duplicate bundle.
            var replay = new ContinuousSaver(root).SaveBundle(files, title: "包2");
            Assert.Equal(ContinuousSaveStatus.SkippedDuplicate, replay.Status);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveSingle_SameContentDifferentName_Skips()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var first = saver.SaveSingle("a.txt", [7, 8, 9]);
            var second = saver.SaveSingle("b.txt", [7, 8, 9]);

            Assert.Equal(ContinuousSaveStatus.Saved, first.Status);
            Assert.Equal(ContinuousSaveStatus.SkippedDuplicate, second.Status);
            Assert.False(File.Exists(Path.Combine(root, "b.txt")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveSingle_SameNameDifferentContent_AppendsCounter()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            saver.SaveSingle("a.txt", [1]);
            var second = saver.SaveSingle("a.txt", [2]);

            Assert.Equal(ContinuousSaveStatus.Saved, second.Status);
            Assert.Equal("a(1).txt", Path.GetFileName(second.FinalPath));
            Assert.Equal(new byte[] { 2 },
                File.ReadAllBytes(Path.Combine(root, "a(1).txt")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveSingle_PreExistingSameContentFile_SkipsAcrossRuns()
    {
        // A file already sitting in the folder from a previous run with the
        // same name AND content must not be duplicated.
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllBytes(Path.Combine(root, "a.txt"), [4, 5]);
            var saver = new ContinuousSaver(root);
            var report = saver.SaveSingle("a.txt", [4, 5]);

            Assert.Equal(ContinuousSaveStatus.SkippedDuplicate, report.Status);
            Assert.Equal("a.txt", Path.GetFileName(Directory.GetFiles(root)[0]));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveText_WritesUtf8WithoutBom()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var report = saver.SaveText("消息.txt", "你好");

            Assert.Equal(ContinuousSaveStatus.Saved, report.Status);
            byte[] written = File.ReadAllBytes(report.FinalPath!);
            Assert.Equal(new byte[] { 0xE4, 0xBD, 0xA0, 0xE5, 0xA5, 0xBD }, written);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveBundle_CreatesSubfolderWithMembers()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var files = new List<BundleFile>
            {
                new("x.jpg", new byte[] { 1 }),
                new("y.jpg", new byte[] { 2, 3 }),
            };
            var report = saver.SaveBundle(files, title: "发送_0816_120000");

            Assert.Equal(ContinuousSaveStatus.Saved, report.Status);
            Assert.Equal("发送_0816_120000", report.BundleDirName);
            string sub = Path.Combine(root, "发送_0816_120000");
            Assert.True(File.Exists(Path.Combine(sub, "x.jpg")));
            Assert.True(File.Exists(Path.Combine(sub, "y.jpg")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveBundle_SameMembersAgain_SkipsWholeBundle()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var files = new List<BundleFile> { new("x.jpg", new byte[] { 9 }) };
            var first = saver.SaveBundle(files, title: "包A");
            var second = saver.SaveBundle(files, title: "包B");

            Assert.Equal(ContinuousSaveStatus.Saved, first.Status);
            Assert.Equal(ContinuousSaveStatus.SkippedDuplicate, second.Status);
            Assert.False(Directory.Exists(Path.Combine(root, "包B")));
            Assert.Single(Directory.GetDirectories(root));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveBundle_ReplayAfterRestart_SkipsViaMarkerFile()
    {
        // The in-memory digest set dies with the saver (app restart); the
        // marker file inside the bundle folder is what makes replayed
        // bundles skip across runs.
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var files = new List<BundleFile> { new("x.jpg", new byte[] { 5 }) };
            var first = new ContinuousSaver(root).SaveBundle(files, title: "包一");
            var second = new ContinuousSaver(root).SaveBundle(files, title: "包二");

            Assert.Equal(ContinuousSaveStatus.Saved, first.Status);
            Assert.Equal(ContinuousSaveStatus.SkippedDuplicate, second.Status);
            Assert.Single(Directory.GetDirectories(root));
            Assert.True(File.Exists(
                Path.Combine(root, "包一", ".airferry-bundle-id")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveBundle_MemberDeletedAfterSave_ReplaySavesFreshCopy()
    {
        // A skip decision must re-verify the folder's actual bytes: with a
        // member deleted, a replayed bundle has to save a fresh copy instead
        // of being swallowed as a duplicate.
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var files = new List<BundleFile>
            {
                new("a.txt", new byte[] { 1 }),
                new("b.txt", new byte[] { 2 }),
            };
            Assert.Equal(ContinuousSaveStatus.Saved,
                saver.SaveBundle(files, title: "包").Status);

            File.Delete(Path.Combine(root, "包", "b.txt"));

            var replay = saver.SaveBundle(files, title: "包");
            Assert.Equal(ContinuousSaveStatus.Saved, replay.Status);
            // Fresh intact copy in a new folder; the user's deletion in the
            // old folder is left untouched.
            Assert.False(File.Exists(Path.Combine(root, "包", "b.txt")));
            Assert.Equal(2, Directory.GetDirectories(root).Length);
            Assert.True(File.Exists(Path.Combine(replay.FinalPath!, "a.txt")));
            Assert.True(File.Exists(Path.Combine(replay.FinalPath!, "b.txt")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveBundle_MemberTamperedAfterSave_ReplaySavesFreshCopy()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var files = new List<BundleFile> { new("a.txt", new byte[] { 1 }) };
            Assert.Equal(ContinuousSaveStatus.Saved,
                saver.SaveBundle(files, title: "包").Status);

            File.WriteAllBytes(Path.Combine(root, "包", "a.txt"), new byte[] { 9 });

            var replay = saver.SaveBundle(files, title: "包");
            Assert.Equal(ContinuousSaveStatus.Saved, replay.Status);
            // Old folder keeps the user's edit; the new copy is pristine.
            Assert.Equal(new byte[] { 9 },
                File.ReadAllBytes(Path.Combine(root, "包", "a.txt")));
            Assert.Equal(new byte[] { 1 },
                File.ReadAllBytes(Path.Combine(replay.FinalPath!, "a.txt")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveBundle_MemberDeletedAfterRestart_ReplaySavesFreshCopy()
    {
        // Restart variant: the in-memory record is gone, so the marker scan
        // must itself re-verify the manifest and refuse the stale match.
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var files = new List<BundleFile>
            {
                new("a.txt", new byte[] { 1 }),
                new("b.txt", new byte[] { 2 }),
            };
            Assert.Equal(ContinuousSaveStatus.Saved,
                new ContinuousSaver(root).SaveBundle(files, title: "包").Status);

            File.Delete(Path.Combine(root, "包", "b.txt"));

            var replay = new ContinuousSaver(root).SaveBundle(files, title: "包");
            Assert.Equal(ContinuousSaveStatus.Saved, replay.Status);
            Assert.Equal("包(1)", replay.BundleDirName);
            Assert.True(File.Exists(Path.Combine(root, "包(1)", "b.txt")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveSingle_FileDeletedAfterSave_ReplaySavesAgain()
    {
        // The same integrity rule for single files: a deleted file must not
        // be skipped as an in-memory duplicate on replay.
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            Assert.Equal(ContinuousSaveStatus.Saved,
                saver.SaveSingle("a.txt", new byte[] { 3, 4 }).Status);

            File.Delete(Path.Combine(root, "a.txt"));

            var replay = saver.SaveSingle("a.txt", new byte[] { 3, 4 });
            Assert.Equal(ContinuousSaveStatus.Saved, replay.Status);
            Assert.Equal(new byte[] { 3, 4 },
                File.ReadAllBytes(Path.Combine(root, "a.txt")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void MoveVerifiedFile_TargetDeletedAfterSave_ReplaysMove()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            byte[] data = [13, 14];
            string sha = Convert.ToHexString(
                System.Security.Cryptography.SHA256.HashData(data)).ToLowerInvariant();
            var saver = new ContinuousSaver(root);

            string src1 = Path.Combine(root, "src1.bin");
            File.WriteAllBytes(src1, data);
            Assert.Equal(ContinuousSaveStatus.Saved,
                saver.MoveVerifiedFile("big.zip", src1, sha).Status);

            File.Delete(Path.Combine(root, "big.zip"));

            string src2 = Path.Combine(root, "src2.bin");
            File.WriteAllBytes(src2, data);
            var replay = saver.MoveVerifiedFile("big.zip", src2, sha);
            Assert.Equal(ContinuousSaveStatus.Saved, replay.Status);
            Assert.Equal(data, File.ReadAllBytes(Path.Combine(root, "big.zip")));
            Assert.False(File.Exists(src2));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveBundle_SanitizedNameCollisions_DoNotOverwriteEachOther()
    {
        // "a:b.txt" and "a*b.txt" both sanitize to "a_b.txt" — the second
        // member must land on "a_b(1).txt", never overwrite the first.
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var files = new List<BundleFile>
            {
                new("a:b.txt", new byte[] { 1 }),
                new("a*b.txt", new byte[] { 2 }),
            };
            var report = saver.SaveBundle(files, title: "包");

            Assert.Equal(ContinuousSaveStatus.Saved, report.Status);
            string sub = Path.Combine(root, "包");
            Assert.Equal(new byte[] { 1 },
                File.ReadAllBytes(Path.Combine(sub, "a_b.txt")));
            Assert.Equal(new byte[] { 2 },
                File.ReadAllBytes(Path.Combine(sub, "a_b(1).txt")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveBundle_LeavesNoStagingTempBehind()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            saver.SaveBundle([new BundleFile("x.txt", new byte[] { 1 })], title: "包");

            // The staging dir is renamed into place; no *.tmp sibling remains
            // and exactly one directory exists.
            Assert.Empty(Directory.GetDirectories(root, "*.tmp"));
            Assert.Single(Directory.GetDirectories(root));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void SaveBundle_WriteFailure_KeepsFolderCleanAndAllowsRetry()
    {
        // POSIX-only: a read-only parent forces the staged member write to
        // fail. The folder must stay clean (no partial bundle, no .tmp), the
        // digest must NOT be registered, and a retry after restoring
        // permissions must succeed.
        if (OperatingSystem.IsWindows())
        {
            return;
        }
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var files = new List<BundleFile> { new("x.txt", new byte[] { 7 }) };
            Chmod(root, "555");
            Assert.ThrowsAny<Exception>(() => saver.SaveBundle(files, title: "包"));
            Chmod(root, "755");

            Assert.Empty(Directory.GetDirectories(root));
            var retry = saver.SaveBundle(files, title: "包");
            Assert.Equal(ContinuousSaveStatus.Saved, retry.Status);
        }
        finally
        {
            Chmod(root, "755");
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ShouldSkipTransfer_MarkedAndIntact_Skips()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var report = saver.SaveSingle("a.txt", new byte[] { 7, 7 });
            var probe = new TransferProbe("0123456789abcdef0123456789abcdef", "a.txt", 2, null, null);
            saver.MarkTransfer(probe, report);

            Assert.True(saver.ShouldSkipTransfer(probe));
            var other = new TransferProbe("fedcba9876543210fedcba9876543210", "other.txt", 2, null, null);
            Assert.False(saver.ShouldSkipTransfer(other));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ShouldSkipTransfer_SavedFileDeleted_AllowsReceiveAgain()
    {
        // A stale identity must never block recovery: once the saved copy is
        // gone, the pre-scan check has to answer "receive it again".
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var report = saver.SaveSingle("a.txt", new byte[] { 7, 7 });
            var probe = new TransferProbe("0123456789abcdef0123456789abcdef", "a.txt", 2, null, null);
            saver.MarkTransfer(probe, report);
            Assert.True(saver.ShouldSkipTransfer(probe));

            File.Delete(Path.Combine(root, "a.txt"));
            Assert.False(saver.ShouldSkipTransfer(probe));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ShouldSkipTransfer_BundleMemberTampered_AllowsReceiveAgain()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var files = new List<BundleFile> { new("x.txt", new byte[] { 1 }) };
            var report = saver.SaveBundle(files, title: "包");
            var probe = new TransferProbe("11112222333344445555666677778888", "包", 1, null, null);
            saver.MarkTransfer(probe, report);
            Assert.True(saver.ShouldSkipTransfer(probe));

            File.WriteAllBytes(Path.Combine(root, "包", "x.txt"), new byte[] { 9 });
            Assert.False(saver.ShouldSkipTransfer(probe));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ShouldSkipTransfer_MatchingRootSha256_SkipsEvenWithDifferentIdentity()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var report = saver.SaveSingle("a.txt", new byte[] { 7, 7 });
            var initial = new TransferProbe("0123456789abcdef0123456789abcdef", "a.txt", 2, null, report.Sha256Hex);
            saver.MarkTransfer(initial, report);

            // Renamed re-send: different identity and file name, but matching RootSha256
            var renamed = new TransferProbe("fedcba9876543210fedcba9876543210", "b.txt", 2, null, report.Sha256Hex);
            Assert.True(saver.ShouldSkipTransfer(renamed));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ShouldSkipTransfer_SurvivesAppRestartViaPersistedIndex()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver1 = new ContinuousSaver(root);
            var report = saver1.SaveSingle("a.txt", new byte[] { 1, 2, 3 });
            var probe = new TransferProbe("0123456789abcdef0123456789abcdef", "a.txt", 3, 0x12345678, report.Sha256Hex);
            saver1.MarkTransfer(probe, report);

            // Re-instantiate saver as if application restarted
            var saver2 = new ContinuousSaver(root);
            Assert.True(saver2.ShouldSkipTransfer(probe));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void MarkTransfer_EmptyDigest_Ignored()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var probe = new TransferProbe("0123456789abcdef0123456789abcdef", "x.txt", 1, null, null);
            var emptyReport = new ContinuousSaveReport(ContinuousSaveStatus.Saved, null, "x.txt", 1, "");
            saver.MarkTransfer(probe, emptyReport);
            Assert.False(saver.ShouldSkipTransfer(probe));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ShouldSkipTransfer_ReTouchedResend_SkipsViaNameSizeCrcTriple()
    {
        // Re-sending the same file after its mtime changed yields a NEW
        // session id — the (name, size, crc32) triple still catches it.
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver1 = new ContinuousSaver(root);
            var report = saver1.SaveSingle("a.txt", new byte[] { 7, 7 });
            saver1.MarkTransfer(
                new TransferProbe("0123456789abcdef0123456789abcdef", "a.txt", 2, 12345u, null),
                report);

            var saver2 = new ContinuousSaver(root); // cross-restart
            Assert.True(saver2.ShouldSkipTransfer(
                new TransferProbe("99990000aaaabbbbccccddddeeeeffff", "a.txt", 2, 12345u, null)));
            // Any leg of the triple off → no skip.
            Assert.False(saver2.ShouldSkipTransfer(
                new TransferProbe("99990000aaaabbbbccccddddeeeeffff", "a.txt", 2, 99999u, null)));
            Assert.False(saver2.ShouldSkipTransfer(
                new TransferProbe("99990000aaaabbbbccccddddeeeeffff", "b.txt", 2, 12345u, null)));
            Assert.False(saver2.ShouldSkipTransfer(
                new TransferProbe("99990000aaaabbbbccccddddeeeeffff", "a.txt", 3, 12345u, null)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void LoadIndex_CorruptJson_ToleratedAndSaveStillWorks()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver1 = new ContinuousSaver(root);
            var report = saver1.SaveSingle("a.txt", new byte[] { 7, 7 });
            var probe = new TransferProbe("0123456789abcdef0123456789abcdef", "a.txt", 2, null, null);
            saver1.MarkTransfer(probe, report);
            File.WriteAllText(
                Path.Combine(root, ".airferry-continuous-index.json"), "{ not json!!");

            // A corrupt index never throws and never blocks receiving; the
            // save-time post-scan dedup is the remaining backstop.
            var saver2 = new ContinuousSaver(root);
            Assert.False(saver2.ShouldSkipTransfer(probe));
            Assert.Equal(ContinuousSaveStatus.SkippedDuplicate,
                saver2.SaveSingle("a.txt", new byte[] { 7, 7 }).Status);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void LoadIndex_PathShapedSavedName_Rejected()
    {
        // The index lives in a user-writable folder: entries pointing outside
        // it must be dropped, never trusted for skip decisions.
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(
                Path.Combine(root, ".airferry-continuous-index.json"),
                "{\"version\":1,\"entries\":[{" +
                "\"identity\":\"0123456789abcdef0123456789abcdef\"," +
                $"\"digest\":\"{new string('a', 64)}\"," +
                "\"kind\":\"file\",\"savedName\":\"..\\evil.txt\"," +
                "\"name\":\"evil.txt\",\"size\":1,\"crc32\":null,\"updatedAt\":1}]}");
            var saver = new ContinuousSaver(root);
            Assert.False(saver.ShouldSkipTransfer(
                new TransferProbe("0123456789abcdef0123456789abcdef", "evil.txt", 1, null, null)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void LoadIndex_EvictsOldestBeyondCap()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            byte[] data = [1, 2, 3];
            string realDigest = Convert.ToHexString(
                System.Security.Cryptography.SHA256.HashData(data)).ToLowerInvariant();
            File.WriteAllBytes(Path.Combine(root, "victim.txt"), data);
            string IdentityOf(int n) => n.ToString("x8") + new string('0', 24);
            var entries = new List<string>(4100);
            for (int i = 0; i <= 4096; i++)
            {
                // Entry 0 (oldest) and entry 4096 (newest) point at the real
                // file; the rest point at missing files with fake digests.
                bool real = i is 0 or 4096;
                string digest = real ? realDigest : new string('a', 64);
                string savedName = real ? "victim.txt" : $"f{i}.txt";
                entries.Add(
                    $"{{\"identity\":\"{IdentityOf(i)}\"," +
                    $"\"digest\":\"{digest}\"," +
                    $"\"kind\":\"file\",\"savedName\":\"{savedName}\"," +
                    $"\"name\":\"n{i}\",\"size\":3,\"crc32\":null,\"updatedAt\":{i + 1}}}");
            }
            File.WriteAllText(
                Path.Combine(root, ".airferry-continuous-index.json"),
                "{\"version\":1,\"entries\":[" + string.Join(',', entries) + "]}");

            var saver = new ContinuousSaver(root);
            // The oldest entry was evicted; the newest survives and skips.
            Assert.False(saver.ShouldSkipTransfer(
                new TransferProbe(IdentityOf(0), "n0", 3, null, null)));
            Assert.True(saver.ShouldSkipTransfer(
                new TransferProbe(IdentityOf(4096), "n4096", 3, null, null)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void MarkTransfer_PersistsIndexAtomicallyWithoutTempLeftovers()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            var saver = new ContinuousSaver(root);
            var report = saver.SaveSingle("a.txt", new byte[] { 5 });
            saver.MarkTransfer(
                new TransferProbe("0123456789abcdef0123456789abcdef", "a.txt", 1, 7u, null),
                report);

            string indexPath = Path.Combine(root, ".airferry-continuous-index.json");
            Assert.True(File.Exists(indexPath));
            Assert.Empty(Directory.GetFiles(root, "*.tmp"));
            string json = File.ReadAllText(indexPath);
            Assert.Contains("0123456789abcdef0123456789abcdef", json);
            Assert.Contains(report.Sha256Hex, json);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static void Chmod(string path, string mode)
    {
        var psi = new System.Diagnostics.ProcessStartInfo(
            "chmod", $" {mode} \"{path}\"")
        {
            UseShellExecute = false,
        };
        System.Diagnostics.Process.Start(psi)?.WaitForExit();
    }

    [Fact]
    public void MoveVerifiedFile_MovesAndDeduplicatesByKnownHash()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            byte[] data = [11, 22, 33];
            string sha = Convert.ToHexString(
                System.Security.Cryptography.SHA256.HashData(data)).ToLowerInvariant();

            var saver = new ContinuousSaver(root);
            string src1 = Path.Combine(root, "src1.bin");
            File.WriteAllBytes(src1, data);
            var first = saver.MoveVerifiedFile("big.zip", src1, sha);

            Assert.Equal(ContinuousSaveStatus.Saved, first.Status);
            Assert.False(File.Exists(src1));
            Assert.Equal(data, File.ReadAllBytes(first.FinalPath!));

            // Same verified hash again (replayed transfer): skipped, source
            // left for the caller's ledger cleanup.
            string src2 = Path.Combine(root, "src2.bin");
            File.WriteAllBytes(src2, data);
            var second = saver.MoveVerifiedFile("big.zip", src2, sha);
            Assert.Equal(ContinuousSaveStatus.SkippedDuplicate, second.Status);
            Assert.True(File.Exists(src2));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void MoveVerifiedFile_InvalidHash_Throws()
    {
        string root = TempRoot();
        Directory.CreateDirectory(root);
        try
        {
            string src = Path.Combine(root, "src.bin");
            File.WriteAllBytes(src, [1]);
            var saver = new ContinuousSaver(root);
            Assert.Throws<ArgumentException>(
                () => saver.MoveVerifiedFile("a", src, "nothex"));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}

public class AppSettingsEscapeTests
{
    [Theory]
    [InlineData("", "")]
    [InlineData("plain", "plain")]
    [InlineData("D:\\接收\\文件夹", "D:\\\\接收\\\\文件夹")]
    [InlineData("a\"b", "a\\\"b")]
    [InlineData("D:\\a\"b\\", "D:\\\\a\\\"b\\\\")]
    public void EscapeJsonString_EscapesBackslashAndQuote(string raw, string escaped)
    {
        Assert.Equal(escaped, Services.AppSettings.EscapeJsonString(raw));
    }

    [Theory]
    [InlineData("", "")]
    [InlineData("plain", "plain")]
    [InlineData("D:\\\\接收\\\\文件夹", "D:\\接收\\文件夹")]
    [InlineData("a\\\"b", "a\"b")]
    [InlineData("trailing\\\\", "trailing\\")]
    public void UnescapeJsonString_RoundTrips(string escaped, string raw)
    {
        Assert.Equal(raw, Services.AppSettings.UnescapeJsonString(escaped));
        Assert.Equal(raw, Services.AppSettings.UnescapeJsonString(
            Services.AppSettings.EscapeJsonString(raw)));
    }

    [Fact]
    public void UnescapeJsonString_DanglingBackslashKeptLiteral()
    {
        Assert.Equal("a\\", Services.AppSettings.UnescapeJsonString("a\\"));
    }
}
