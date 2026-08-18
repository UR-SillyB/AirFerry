using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AirFerry.Windows.Bundle;

/// <summary>
/// Content-addressed store + logical entry index (mirrors Android ContentStore).
/// Layout under Documents/AirFerry/store/:
///   blobs/hh/sha256
///   index.json
/// </summary>
public static class ContentStore
{
    private static readonly object Gate = new();
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    public sealed record Entry(
        string Id,
        string Name,
        string Hash,
        long Size,
        string CrcHex,
        bool CrcUnknown,
        string Kind,
        long CreatedAt,
        string? BundleId,
        string? BundleTitle);

    public sealed record PutResult(Entry Entry, string Path, bool Deduped);

    public sealed record PutBytesRequest(
        string DisplayName,
        byte[] Bytes,
        string CrcHex = "unknown",
        bool CrcUnknown = true,
        string Kind = "file",
        string? BundleId = null,
        string? BundleTitle = null);

    public sealed record PutFileRequest(
        string DisplayName,
        string FilePath,
        string CrcHex = "unknown",
        bool CrcUnknown = true,
        string Kind = "file",
        string? BundleId = null,
        string? BundleTitle = null,
        long? ExpectedSize = null);

    public static string RootDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            "AirFerry", "store");

    private static string IndexPath => Path.Combine(RootDir, "index.json");

    public static string BlobPath(string hash)
    {
        string h = hash.ToLowerInvariant();
        if (h.Length != 64 || h.Any(c => !Uri.IsHexDigit(c)))
        {
            throw new ArgumentException("Invalid SHA-256 hash", nameof(hash));
        }
        string dir = Path.Combine(RootDir, "blobs", h[..2]);
        Directory.CreateDirectory(dir);
        return Path.Combine(dir, h);
    }

    public static string Sha256Hex(byte[] bytes)
    {
        byte[] d = SHA256.HashData(bytes);
        return Convert.ToHexString(d).ToLowerInvariant();
    }

    public static PutResult PutBytes(
        string displayName,
        byte[] bytes,
        string crcHex = "unknown",
        bool crcUnknown = true,
        string kind = "file",
        string? bundleId = null,
        string? bundleTitle = null)
    {
        return PutBytesBatch(
        [
            new PutBytesRequest(
                displayName, bytes, crcHex, crcUnknown, kind, bundleId, bundleTitle)
        ]).Single();
    }

    /// <summary>Archive a bundle with one index read/write instead of O(n²) rewrites.</summary>
    public static IReadOnlyList<PutResult> PutBytesBatch(
        IReadOnlyList<PutBytesRequest> requests)
    {
        if (requests.Count == 0) return [];
        lock (Gate)
        {
            // Fail closed before writing a blob. Treating a corrupt index as an
            // empty history would make the next receive overwrite every logical
            // entry and orphan otherwise-valid content-addressed blobs.
            var all = LoadIndex();
            Directory.CreateDirectory(RootDir);
            long createdAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var results = new List<PutResult>(requests.Count);
            foreach (PutBytesRequest request in requests)
            {
                string hash = Sha256Hex(request.Bytes);
                string path = BlobPath(hash);
                bool deduped = FileMatchesHash(path, hash, request.Bytes.LongLength);
                if (!deduped)
                {
                    WriteAllBytesAtomic(path, request.Bytes);
                }
                var entry = new Entry(
                    Id: Guid.NewGuid().ToString("N"),
                    Name: request.BundleId is not null
                        ? FileNameUtil.SanitizeRelativePath(request.DisplayName)
                        : FileNameUtil.Sanitize(request.DisplayName),
                    Hash: hash,
                    Size: request.Bytes.LongLength,
                    CrcHex: request.CrcHex,
                    CrcUnknown: request.CrcUnknown,
                    Kind: request.Kind,
                    CreatedAt: createdAt,
                    BundleId: request.BundleId,
                    BundleTitle: request.BundleTitle);
                all.Add(entry);
                results.Add(new PutResult(entry, path, deduped));
            }
            SaveIndex(all);
            return results;
        }
    }

    /// <summary>
    /// Archive a bundle of pre-staged files with ONE index write so a mid-bundle
    /// disk failure cannot leave a truncated bundle committed to history (and to
    /// avoid O(n²) index rewrites). The index is only saved after every member
    /// has been hashed and moved into the blob tree; blobs moved by a FAILED
    /// batch that no pre-existing entry references are deleted in the failure
    /// unwind (no orphan space leak, retry-safe). Callers own leftover staged
    /// files when the batch throws.
    /// </summary>
    public static IReadOnlyList<PutResult> PutFileBatch(
        IReadOnlyList<PutFileRequest> requests)
    {
        if (requests.Count == 0) return [];
        lock (Gate)
        {
            var all = LoadIndex();
            var priorHashes = all.Select(e => e.Hash).ToHashSet(StringComparer.Ordinal);
            Directory.CreateDirectory(RootDir);
            long createdAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var results = new List<PutResult>(requests.Count);
            var movedBlobs = new List<string>();
            try
            {
                foreach (PutFileRequest request in requests)
                {
                    if (!File.Exists(request.FilePath))
                        throw new FileNotFoundException(
                            "Staged bundle member is missing", request.FilePath);
                    long sourceLength = new FileInfo(request.FilePath).Length;
                    if (request.ExpectedSize is not null && sourceLength != request.ExpectedSize.Value)
                        throw new InvalidDataException("staged file length differs from manifest");
                    string hash = Sha256HexFile(request.FilePath);
                    string path = BlobPath(hash);
                    bool deduped = FileMatchesHash(path, hash, sourceLength);
                    if (!deduped)
                    {
                        MoveFileAtomic(request.FilePath, path);
                        movedBlobs.Add(path);
                    }
                    var entry = new Entry(
                        Id: Guid.NewGuid().ToString("N"),
                        Name: request.BundleId is not null
                            ? FileNameUtil.SanitizeRelativePath(request.DisplayName)
                            : FileNameUtil.Sanitize(request.DisplayName),
                        Hash: hash,
                        Size: sourceLength,
                        CrcHex: request.CrcHex,
                        CrcUnknown: request.CrcUnknown,
                        Kind: request.Kind,
                        CreatedAt: createdAt,
                        BundleId: request.BundleId,
                        BundleTitle: request.BundleTitle);
                    all.Add(entry);
                    results.Add(new PutResult(entry, path, deduped));
                }
                SaveIndex(all);
            }
            catch
            {
                // Pre-commit failure unwind: blobs moved by THIS batch that no
                // pre-existing entry references are orphans — delete them so
                // the failure leaks no space and the batch is retryable.
                foreach (string blob in movedBlobs)
                {
                    string hash = Path.GetFileName(blob);
                    if (!priorHashes.Contains(hash))
                    {
                        try { File.Delete(blob); } catch { }
                    }
                }
                throw;
            }
            return results;
        }
    }

    /// <summary>
    /// Archive an existing file (e.g. a fully-assembled large-transfer) into the
    /// content-addressed store by streaming its hash and atomically moving it
    /// into the blob tree — no full-file in-memory or on-disk copy. If index
    /// publication fails, the task ledger can retry against the verified blob.
    /// </summary>
    public static PutResult PutFile(
        string displayName,
        string filePath,
        string crcHex = "unknown",
        bool crcUnknown = true,
        string kind = "file",
        string? bundleId = null,
        string? bundleTitle = null,
        string? expectedSha256Hex = null,
        long? expectedSize = null,
        string? stableEntryId = null)
    {
        lock (Gate)
        {
            var all = LoadIndex();
            Directory.CreateDirectory(RootDir);
            string? expectedHash = expectedSha256Hex?.ToLowerInvariant();
            if (expectedHash is not null &&
                (expectedHash.Length != 64 || expectedHash.Any(c => !Uri.IsHexDigit(c))))
                throw new ArgumentException("Invalid expected SHA-256 hash",
                    nameof(expectedSha256Hex));
            bool sourceExists = File.Exists(filePath);
            long sourceLength = sourceExists
                ? new FileInfo(filePath).Length
                : expectedSize ?? throw new FileNotFoundException(
                    "Assembled task file is missing", filePath);
            if (expectedSize is not null && sourceLength != expectedSize.Value)
                throw new InvalidDataException("assembled file length differs from manifest");
            string hash = sourceExists ? Sha256HexFile(filePath) : expectedHash!;
            if (expectedHash is not null &&
                !string.Equals(hash, expectedHash, StringComparison.Ordinal))
                throw new InvalidDataException("assembled file SHA-256 differs from manifest");
            string path = BlobPath(hash);
            bool deduped = FileMatchesHash(path, hash, sourceLength);
            if (!deduped)
            {
                if (!sourceExists)
                    throw new FileNotFoundException(
                        "Assembled source and verified content blob are both missing", filePath);
                MoveFileAtomic(filePath, path);
            }
            Entry? existing = stableEntryId is null
                ? null
                : all.FirstOrDefault(e => e.Id == stableEntryId);
            if (existing is not null)
            {
                if (!string.Equals(existing.Hash, hash, StringComparison.Ordinal) ||
                    existing.Size != sourceLength)
                    throw new InvalidDataException(
                        "stable content entry id conflicts with existing history");
                if (!string.Equals(Path.GetFullPath(filePath), Path.GetFullPath(path),
                        StringComparison.OrdinalIgnoreCase))
                {
                    try { File.Delete(filePath); } catch { /* task cleanup retries */ }
                }
                return new PutResult(existing, path, true);
            }
            var entry = new Entry(
                Id: stableEntryId ?? Guid.NewGuid().ToString("N"),
                Name: bundleId is not null
                    ? FileNameUtil.SanitizeRelativePath(displayName)
                    : FileNameUtil.Sanitize(displayName),
                Hash: hash,
                Size: new FileInfo(path).Length,
                CrcHex: crcHex,
                CrcUnknown: crcUnknown,
                Kind: kind,
                CreatedAt: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                BundleId: bundleId,
                BundleTitle: bundleTitle);
            all.Add(entry);
            SaveIndex(all);
            if (!string.Equals(Path.GetFullPath(filePath), Path.GetFullPath(path),
                    StringComparison.OrdinalIgnoreCase))
            {
                try { File.Delete(filePath); } catch { /* task cleanup retries */ }
            }
            return new PutResult(entry, path, deduped);
        }
    }

    /// <summary>Streaming SHA-256 of a file (no full-file in-memory buffer).</summary>
    private static string Sha256HexFile(string path)
    {
        using var sha = System.Security.Cryptography.SHA256.Create();
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read);
        return Convert.ToHexString(sha.ComputeHash(fs)).ToLowerInvariant();
    }

    public static IReadOnlyList<Entry> ListEntries()
    {
        lock (Gate) return LoadIndex();
    }

    public static bool DeleteEntry(string id)
    {
        lock (Gate)
        {
            var all = LoadIndex();
            int idx = all.FindIndex(e => e.Id == id);
            if (idx < 0) return false;
            Entry removed = all[idx];
            all.RemoveAt(idx);
            SaveIndex(all);
            if (all.TrueForAll(e => e.Hash != removed.Hash))
            {
                string p = BlobPath(removed.Hash);
                if (File.Exists(p)) File.Delete(p);
            }
            return true;
        }
    }

    public static void ClearAll()
    {
        lock (Gate)
        {
            SaveIndex([]);
            string blobs = Path.Combine(RootDir, "blobs");
            if (Directory.Exists(blobs)) Directory.Delete(blobs, recursive: true);
            string segments = Path.Combine(RootDir, "seg");
            if (Directory.Exists(segments)) Directory.Delete(segments, recursive: true);
        }
    }

    /// <summary>Legacy archive directory, retained only for one-time migration.</summary>
    private static string LegacyReceivedDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            "AirFerry", "received");

    /// <summary>Import legacy Documents/AirFerry/received once if store is empty.</summary>
    public static void MigrateLegacyReceivedIfNeeded()
    {
        lock (Gate)
        {
            if (LoadIndex().Count > 0) return;
            string legacy = LegacyReceivedDir;
            if (!Directory.Exists(legacy)) return;
            foreach (string f in Directory.EnumerateFiles(legacy, "*", SearchOption.AllDirectories))
            {
                if (f.EndsWith(".meta", StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    byte[] bytes = File.ReadAllBytes(f);
                    string name = Path.GetFileName(f);
                    PutBytes(name, bytes);
                }
                catch
                {
                    // skip
                }
            }
            try
            {
                string bak = legacy + ".bak." + DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                Directory.Move(legacy, bak);
            }
            catch
            {
                // leave legacy in place if rename fails
            }
        }
    }

    private static List<Entry> LoadIndex()
    {
        if (!File.Exists(IndexPath)) return [];
        try
        {
            string json = File.ReadAllText(IndexPath, Encoding.UTF8);
            List<Entry> entries = JsonSerializer.Deserialize<List<Entry>>(json, JsonOpts)
                ?? throw new InvalidDataException("ContentStore index is null");
            if (entries.Any(e => e is null || e.Size < 0 || e.Hash is null ||
                                 e.Hash.Length != 64 || !e.Hash.All(Uri.IsHexDigit)))
            {
                throw new InvalidDataException("ContentStore index contains an invalid entry");
            }
            return entries;
        }
        catch (Exception ex)
        {
            // The backup path itself touches the filesystem — if the index
            // vanished between the read above and here, re-throwing a raw IO
            // exception would escape as a non-InvalidDataException and crash
            // callers that only guard the corruption case.
            string backup = "";
            try
            {
                backup = Path.Combine(
                    RootDir,
                    $"index.corrupt.{File.GetLastWriteTimeUtc(IndexPath).Ticks}.json");
                if (!File.Exists(backup)) File.Copy(IndexPath, backup, overwrite: false);
            }
            catch
            {
                // Preserve the original index in place even if the backup copy
                // cannot be created (disk full/permissions).
            }
            throw new InvalidDataException(
                $"接收历史索引已损坏，已停止写入以保护现有数据。备份: {backup}", ex);
        }
    }

    private static void SaveIndex(List<Entry> entries)
    {
        Directory.CreateDirectory(RootDir);
        string json = JsonSerializer.Serialize(entries, JsonOpts);
        string temp = Path.Combine(RootDir, $"index.{Guid.NewGuid():N}.tmp");
        try
        {
            byte[] encoded = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)
                .GetBytes(json);
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write,
                       FileShare.None, 64 * 1024, FileOptions.WriteThrough))
            {
                stream.Write(encoded);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temp, IndexPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    private static bool FileMatchesHash(string path, string expectedHash, long expectedSize)
    {
        if (!File.Exists(path) || new FileInfo(path).Length != expectedSize) return false;
        try
        {
            using FileStream stream = File.OpenRead(path);
            string actual = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            return CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(actual), Encoding.ASCII.GetBytes(expectedHash));
        }
        catch
        {
            return false;
        }
    }

    private static void WriteAllBytesAtomic(string path, byte[] bytes)
    {
        string? dir = Path.GetDirectoryName(path);
        if (dir is null) throw new IOException("Blob path has no directory");
        Directory.CreateDirectory(dir);
        string temp = Path.Combine(dir, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write,
                       FileShare.None, 64 * 1024, FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    private static void MoveFileAtomic(string source, string target)
    {
        string? dir = Path.GetDirectoryName(target);
        if (dir is null) throw new IOException("Blob path has no directory");
        Directory.CreateDirectory(dir);
        File.Move(source, target, overwrite: true);
    }
}
