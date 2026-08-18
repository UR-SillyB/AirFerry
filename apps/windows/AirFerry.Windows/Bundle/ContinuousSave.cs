using System.Buffers.Binary;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace AirFerry.Windows.Bundle;

public enum ContinuousSaveStatus
{
    Saved,
    SkippedDuplicate,
    Failed,
}

/// <summary>Outcome of one continuous-mode save attempt.</summary>
/// <param name="FinalPath">Saved file path, or the bundle subfolder path.</param>
/// <param name="BundleDirName">Subfolder name for bundle saves, else null.</param>
/// <param name="Error">Failure reason when <see cref="ContinuousSaveStatus.Failed"/>.</param>
public sealed record ContinuousSaveReport(
    ContinuousSaveStatus Status,
    string? FinalPath,
    string DisplayName,
    long SizeBytes,
    string Sha256Hex,
    string? BundleDirName = null,
    string? Error = null)
{
    public static ContinuousSaveReport Failed(string displayName, string error) =>
        new(ContinuousSaveStatus.Failed, null, displayName, 0, string.Empty, null, error);
}

/// <summary>
/// Continuous-receive sink: saves recovered payloads straight into a
/// user-chosen folder (never the ContentStore — continuous mode's single
/// source of truth is the folder, so large files are not stored twice).
/// Deduplication is content-based and **always re-verified against the
/// folder's actual bytes** before a skip: users delete or edit received
/// files, and a stale record must never block recovering them again.
/// <list type="bullet">
/// <item>an in-memory digest→saved-path map covers this run;</item>
/// <item>when the target name already exists in the folder with the same
/// size and hash (e.g. from a previous run), the save is skipped too —
/// a genuinely different file still lands via the usual <c>name(1)</c>
/// numbering.</item>
/// </list>
/// Bundles go into their own uniquified subfolder and are deduplicated as a
/// whole by a digest over member names + contents. Each bundle folder
/// carries its digest **and a per-member manifest (final name / size /
/// SHA-256)** in a marker file (<c>.airferry-bundle-id</c>): a marker hit
/// re-hashes the actual members, so a replayed bundle skips only while the
/// previous copy is still intact — across app restarts too. Deleting or
/// tampering with a member breaks the match and the next replay saves a
/// fresh copy.
/// Single-threaded by design: the recovery pipeline runs one save at a time.
/// </summary>
/// <summary>
/// Identity facts of one incoming transfer — all known once its ROOT/META is
/// confirmed, and the input to the pre-scan duplicate check.
/// </summary>
/// <param name="Identity">Content-derived Content/Transfer id (whichever the
/// snapshot exposes first), or the session id before META is confirmed.</param>
/// <param name="Name">File name from the manifest snapshot.</param>
/// <param name="Size">Total raw (decompressed) content size.</param>
/// <param name="Crc32">Legacy v1 CRC32, unused in AF2 (always null).</param>
/// <param name="RootSha256Hex">Legacy v1 segment root hash, unused in AF2
/// (always null).</param>
public sealed record TransferProbe(
    string Identity, string Name, long Size, uint? Crc32, string? RootSha256Hex);

public sealed class ContinuousSaver
{
    /// <summary>
    /// Marker file dropped inside every saved bundle folder carrying the
    /// bundle digest plus a per-member manifest. Dedup truth travels with
    /// the data: deleting a bundle folder removes its dedup entry, and a
    /// restarted app (fresh saver) still skips a replayed bundle by scanning
    /// these markers — but only after re-verifying the members on disk.
    /// </summary>
    private const string BundleMarkerFileName = ".airferry-bundle-id";

    /// <summary>
    /// Hidden index file in the target folder root persisting the dedup
    /// records, so the pre-scan skip survives app restarts. Dedup truth
    /// travels with the data, same as the bundle markers: copying the folder
    /// elsewhere carries the index, deleting it resets dedup.
    /// </summary>
    private const string IndexFileName = ".airferry-continuous-index.json";

    /// <summary>Cap on persisted records; the oldest by updatedAt are evicted.</summary>
    private const int MaxIndexEntries = 4096;

    /// <summary>Where a digest was previously saved, for re-verified skips.</summary>
    private sealed record SavedRecord(string Path, bool IsBundle);

    /// <summary>Marker payload: whole-bundle digest + per-member manifest.</summary>
    private sealed record BundleMarker(
        string Digest,
        IReadOnlyList<BundleMemberManifestEntry> Members);

    private sealed record BundleMemberManifestEntry(string Name, long Size, string Sha256);

    /// <summary>One persisted dedup record; names are plain relative file names.</summary>
    private sealed record IndexEntry(
        string Identity, string Digest, string Kind, string SavedName,
        string Name, long Size, uint? Crc32, long UpdatedAt);

    /// <summary>Content lookup key for renamed / re-touched re-sends.</summary>
    private readonly record struct TripleKey(string Name, long Size, uint Crc32);

    private readonly string _dir;
    private readonly Dictionary<string, SavedRecord> _saved = new(StringComparer.Ordinal);
    /// <summary>Transfer identity (session/root id) → saved content digest.</summary>
    private readonly Dictionary<string, string> _transferIdentity = new(StringComparer.Ordinal);
    /// <summary>(name, size, crc32) → saved content digest.</summary>
    private readonly Dictionary<TripleKey, string> _byTriple = new();
    /// <summary>Persisted records backing both lookup maps.</summary>
    private readonly List<IndexEntry> _entries = new();

    /// <summary>
    /// Record a transfer as received, mapped to the content digest it was
    /// saved under. Enables the pre-scan duplicate check below — across
    /// restarts too, via the persisted index. The probe's descriptor facts are
    /// recorded alongside, so a renamed or re-touched re-send (new session id,
    /// same content) is still caught pre-scan. Reports with an empty digest
    /// (or without a verified on-disk record to point at) are ignored.
    /// </summary>
    public void MarkTransfer(TransferProbe probe, ContinuousSaveReport report)
    {
        string digest = report.Sha256Hex;
        if (string.IsNullOrEmpty(digest) ||
            string.IsNullOrEmpty(probe.Identity) ||
            string.IsNullOrEmpty(probe.Name))
        {
            return;
        }
        if (!_saved.TryGetValue(digest, out SavedRecord? record))
        {
            return;
        }
        string savedName = Path.GetFileName(record.Path);
        if (string.IsNullOrEmpty(savedName))
        {
            return;
        }
        AddEntry(new IndexEntry(
            probe.Identity, digest, record.IsBundle ? "bundle" : "file",
            savedName, probe.Name, probe.Size, probe.Crc32,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
        EvictOverflow();
        PersistIndex();
    }

    /// <summary>
    /// Pre-scan duplicate check: true only when the incoming transfer matches a
    /// previous save AND its folder copy still verifies intact — a deleted or
    /// tampered previous copy must stay recoverable, so a stale record never
    /// blocks receiving again. Three levels, strongest first:
    /// ① the exact transfer identity (content-derived Content/Transfer id);
    /// ② the whole-content root hash — cryptographic, catches renamed re-sends
    ///   of single-file transfers (bundle/text digests are over the container,
    ///   not the content root hash; those fall back to ① or post-scan);
    /// ③ the (name, size, CRC32) triple — CRC32 is NOT an authenticator, but a
    ///   same-name same-size match implies equal content in practice (~2⁻³²
    ///   accidental collision per pair); the post-scan save-time dedup remains
    ///   as the backstop either way.
    /// </summary>
    public bool ShouldSkipTransfer(TransferProbe probe)
    {
        if (_transferIdentity.TryGetValue(probe.Identity, out string? digest) &&
            VerifyDigest(digest))
        {
            return true;
        }
        if (probe.RootSha256Hex is { Length: 64 } rootSha &&
            VerifyDigest(rootSha))
        {
            return true;
        }
        if (probe.Crc32 is uint crc &&
            _byTriple.TryGetValue(
                new TripleKey(probe.Name, probe.Size, crc), out string? tripleDigest) &&
            VerifyDigest(tripleDigest))
        {
            return true;
        }
        return false;
    }

    private bool VerifyDigest(string digest) =>
        _saved.TryGetValue(digest, out SavedRecord? record) &&
        VerifySavedRecord(record, digest);

    public ContinuousSaver(string targetDir)
    {
        if (string.IsNullOrWhiteSpace(targetDir))
        {
            throw new ArgumentException("持续接收目录不能为空", nameof(targetDir));
        }
        _dir = targetDir;
        LoadIndex();
    }

    public string TargetDir => _dir;

    /// <summary>Save a recovered single file by its raw bytes.</summary>
    public ContinuousSaveReport SaveSingle(string displayName, byte[] bytes) =>
        SaveBytes(displayName, bytes);

    /// <summary>Save a recovered path-backed file without loading it into memory.</summary>
    public ContinuousSaveReport SaveSingle(BundleFile file)
    {
        using Stream input = file.OpenRead();
        string hash = Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant();
        if (_saved.TryGetValue(hash, out SavedRecord? seen) &&
            VerifySavedRecord(seen, hash))
        {
            return Skip(file.Name, file.Size, hash);
        }
        _saved.Remove(hash);
        string? target = ResolveTarget(file.Name, file.Size, hash);
        if (target is null)
        {
            _saved[hash] = new SavedRecord(
                Path.Combine(_dir, FileNameUtil.Sanitize(file.Name)),
                IsBundle: false);
            return Skip(file.Name, file.Size, hash);
        }
        WriteAtomic(target, file);
        _saved[hash] = new SavedRecord(target, IsBundle: false);
        return new ContinuousSaveReport(
            ContinuousSaveStatus.Saved, target, Path.GetFileName(target), file.Size, hash);
    }

    /// <summary>
    /// Save a text message as UTF-8 (no BOM) under the (already normalized)
    /// descriptor name — the same encoding ReceiveTextView's save-as uses.
    /// </summary>
    public ContinuousSaveReport SaveText(string displayName, string text) =>
        SaveBytes(displayName, new UTF8Encoding(false).GetBytes(text));

    /// <summary>
    /// Save a parsed bundle into its own subfolder (title defaults to the
    /// same 发送_MMdd_HHmmss pattern the ContentStore history uses).
    /// Transactional: members are staged in a hidden temp sibling directory
    /// and revealed with one rename, so a mid-bundle failure never leaves a
    /// normal-looking partial folder behind. Safe relative directories from
    /// the Manifest are preserved; collisions within the same directory get
    /// the usual "(N)" suffix instead of overwriting each other.
    /// Whole-bundle dedup survives restarts via <see cref="BundleMarkerFileName"/>
    /// and is re-verified against the members on disk on every hit.
    /// </summary>
    public ContinuousSaveReport SaveBundle(
        IReadOnlyList<BundleFile> files, string? title)
    {
        if (files.Count == 0)
        {
            throw new ArgumentException("文件包为空", nameof(files));
        }
        string name = string.IsNullOrWhiteSpace(title)
            ? $"发送_{DateTime.Now:MMdd_HHmmss}"
            : title!;
        long total = files.Sum(f => f.Size);
        string digest = BundleDigest(files);
        if (_saved.TryGetValue(digest, out SavedRecord? seen) &&
            VerifySavedRecord(seen, digest))
        {
            return Skip(name, total, digest);
        }
        _saved.Remove(digest); // stale record — the folder no longer matches
        // Cross-restart replay: a previous run's bundle folder still carries
        // its digest marker — skip only if every manifest member is still
        // intact on disk; otherwise save a fresh copy so the user can recover
        // what they deleted or edited.
        if (FindIntactBundleDir(digest) is { } existingDir)
        {
            _saved[digest] = new SavedRecord(existingDir, IsBundle: true);
            return Skip(name, total, digest);
        }
        string safe = FileNameUtil.Sanitize(name);
        string finalDir = UniqueDir(safe);
        string stagingDir = $"{finalDir}.{Guid.NewGuid():N}.tmp";
        try
        {
            Directory.CreateDirectory(stagingDir);
            var manifest = new List<BundleMemberManifestEntry>(files.Count);
            foreach (BundleFile f in files)
            {
                string memberPath = FileNameUtil.UniqueRelativeTarget(stagingDir, f.Name);
                WriteAtomic(memberPath, f);
                string relative = Path.GetRelativePath(stagingDir, memberPath)
                    .Replace('\\', '/');
                manifest.Add(new BundleMemberManifestEntry(
                    relative,
                    f.Size,
                    ContentStoreSha256(f)));
            }
            WriteBundleMarker(stagingDir, new BundleMarker(digest, manifest));
            Directory.Move(stagingDir, finalDir);
        }
        catch
        {
            TryDeleteDir(stagingDir);
            throw;
        }
        _saved[digest] = new SavedRecord(finalDir, IsBundle: true);
        return new ContinuousSaveReport(
            ContinuousSaveStatus.Saved, finalDir, safe, total, digest,
            BundleDirName: Path.GetFileName(finalDir));
    }

    /// <summary>
    /// Move an already-verified on-disk file (the &gt;256 MiB segmented
    /// archive path; the native decompression verified its root SHA-256)
    /// into the folder. On duplicate the source file is left for the caller
    /// (the segment task ledger deletes it with its directory).
    /// Never uses <c>File.Move</c> directly across volumes: the temp file
    /// lives in Documents while the target folder may be another drive /
    /// USB stick, where Move's copy+delete fallback can fail midway. Instead:
    /// copy to a temp file on the TARGET volume, flush, re-verify the SHA-256,
    /// atomically rename, and only then delete the source.
    /// </summary>
    public ContinuousSaveReport MoveVerifiedFile(
        string displayName, string sourcePath, string sha256Hex)
    {
        string hash = sha256Hex.ToLowerInvariant();
        if (hash.Length != 64 || hash.Any(c => !Uri.IsHexDigit(c)))
        {
            throw new ArgumentException("Invalid SHA-256 hash", nameof(sha256Hex));
        }
        long size = new FileInfo(sourcePath).Length; // throws if the file vanished
        if (_saved.TryGetValue(hash, out SavedRecord? seen) &&
            VerifySavedRecord(seen, hash))
        {
            return Skip(displayName, size, hash);
        }
        _saved.Remove(hash);
        string? target = ResolveTarget(displayName, size, hash);
        if (target is null)
        {
            // Same name + same content already in the folder (previous run).
            _saved[hash] = new SavedRecord(
                Path.Combine(_dir, FileNameUtil.Sanitize(displayName)),
                IsBundle: false);
            return Skip(displayName, size, hash);
        }
        string? targetDir = Path.GetDirectoryName(target);
        if (targetDir is null) throw new IOException("目标路径没有目录");
        Directory.CreateDirectory(targetDir);
        string temp = Path.Combine(
            targetDir, $".{Path.GetFileName(target)}.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var src = new FileStream(
                       sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var dst = new FileStream(
                       temp, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                       64 * 1024, FileOptions.WriteThrough))
            {
                src.CopyTo(dst);
                dst.Flush(flushToDisk: true);
            }
            if (HashFile(temp) != hash)
            {
                throw new IOException("复制后 SHA-256 校验失败");
            }
            File.Move(temp, target);
            // The folder now holds the verified copy; the source's owner (the
            // segment ledger) cleans it up with its task directory.
            try { File.Delete(sourcePath); }
            catch { /* ledger cleanup retries; the folder copy is complete */ }
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
        _saved[hash] = new SavedRecord(target, IsBundle: false);
        return new ContinuousSaveReport(
            ContinuousSaveStatus.Saved, target, Path.GetFileName(target), size, hash);
    }

    private ContinuousSaveReport SaveBytes(string displayName, byte[] bytes)
    {
        string hash = ContentStoreSha256(bytes);
        long size = bytes.LongLength;
        if (_saved.TryGetValue(hash, out SavedRecord? seen) &&
            VerifySavedRecord(seen, hash))
        {
            return Skip(displayName, size, hash);
        }
        _saved.Remove(hash);
        string? target = ResolveTarget(displayName, size, hash);
        if (target is null)
        {
            // Same name + same content already in the folder (previous run).
            _saved[hash] = new SavedRecord(
                Path.Combine(_dir, FileNameUtil.Sanitize(displayName)),
                IsBundle: false);
            return Skip(displayName, size, hash);
        }
        WriteAtomic(target, bytes);
        _saved[hash] = new SavedRecord(target, IsBundle: false);
        return new ContinuousSaveReport(
            ContinuousSaveStatus.Saved, target, Path.GetFileName(target), size, hash);
    }

    /// <summary>
    /// Resolve the final target path for a name, or null when an existing
    /// same-name file holds identical content (cross-run duplicate).
    /// </summary>
    private string? ResolveTarget(string displayName, long expectedSize, string expectedHash)
    {
        string safe = FileNameUtil.Sanitize(displayName);
        string first = Path.Combine(_dir, safe);
        if (File.Exists(first))
        {
            if (new FileInfo(first).Length == expectedSize &&
                HashFile(first) == expectedHash)
            {
                return null;
            }
            // Different content under the same name → name(N) via the shared
            // helper (it re-checks existence, starting at (1)).
            return FileNameUtil.UniqueTarget(_dir, safe);
        }
        return first;
    }

    /// <summary>
    /// Re-verify a dedup hit against the folder's actual bytes. A record is
    /// only trustworthy while what it points at is still there unchanged.
    /// </summary>
    private bool VerifySavedRecord(SavedRecord record, string expectedDigest)
    {
        return record.IsBundle
            ? VerifyBundleDir(record.Path, expectedDigest)
            : VerifySingleFile(record.Path, expectedDigest);
    }

    private static bool VerifySingleFile(string path, string expectedDigest)
    {
        return File.Exists(path) && HashFile(path) == expectedDigest;
    }

    /// <summary>
    /// A bundle folder counts as an intact duplicate only when its marker
    /// still parses, still matches the digest, and every manifest member is
    /// present with the recorded size and SHA-256.
    /// </summary>
    private bool VerifyBundleDir(string dir, string expectedDigest)
    {
        BundleMarker? marker = TryReadBundleMarker(dir);
        if (marker is null ||
            !string.Equals(marker.Digest, expectedDigest, StringComparison.OrdinalIgnoreCase) ||
            marker.Members.Count == 0)
        {
            return false;
        }
        foreach (BundleMemberManifestEntry m in marker.Members)
        {
            // Marker paths are our own sanitized bundle-relative names. Any
            // traversal or illegal component changes under re-sanitization and
            // therefore fails closed before Path.Combine is used.
            string normalized = m.Name.Replace('\\', '/');
            if (!string.Equals(
                    FileNameUtil.SanitizeRelativePath(normalized),
                    normalized,
                    StringComparison.Ordinal))
            {
                return false;
            }
            string path = Path.Combine(dir, normalized.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(path) ||
                new FileInfo(path).Length != m.Size ||
                HashFile(path) != m.Sha256)
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>First bundle folder whose marker matches AND verifies intact.</summary>
    private string? FindIntactBundleDir(string digest)
    {
        try
        {
            foreach (string dir in Directory.EnumerateDirectories(_dir))
            {
                if (VerifyBundleDir(dir, digest))
                {
                    return dir;
                }
            }
        }
        catch
        {
            // Target dir missing (first save) or unreadable — save normally.
        }
        return null;
    }

    private static void WriteBundleMarker(string stagingDir, BundleMarker marker)
    {
        File.WriteAllText(
            Path.Combine(stagingDir, BundleMarkerFileName),
            JsonSerializer.Serialize(marker),
            new UTF8Encoding(false));
    }

    private static BundleMarker? TryReadBundleMarker(string dir)
    {
        try
        {
            string marker = Path.Combine(dir, BundleMarkerFileName);
            if (!File.Exists(marker))
            {
                return null;
            }
            return JsonSerializer.Deserialize<BundleMarker>(
                File.ReadAllText(marker));
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Hydrate the dedup records from <see cref="IndexFileName"/> in the target
    /// folder. A missing or corrupt index starts empty — dedup then degrades
    /// to the save-time checks, never blocks receiving. Every entry is
    /// validated defensively: the file lives in a user-writable folder.
    /// </summary>
    private void LoadIndex()
    {
        try
        {
            string path = Path.Combine(_dir, IndexFileName);
            if (!File.Exists(path))
            {
                return;
            }
            using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
            if (!doc.RootElement.TryGetProperty("entries", out JsonElement entries) ||
                entries.ValueKind != JsonValueKind.Array)
            {
                return;
            }
            foreach (JsonElement el in entries.EnumerateArray())
            {
                if (ParseEntry(el) is { } entry)
                {
                    AddEntry(entry);
                }
            }
            EvictOverflow();
        }
        catch
        {
            // Corrupt/unreadable index mid-parse — drop partial state.
            _entries.Clear();
            _transferIdentity.Clear();
            _byTriple.Clear();
            _saved.Clear();
        }
    }

    private static IndexEntry? ParseEntry(JsonElement el)
    {
        try
        {
            string? identity = el.GetProperty("identity").GetString();
            string? digest = el.GetProperty("digest").GetString();
            string? kind = el.GetProperty("kind").GetString();
            string? savedName = el.GetProperty("savedName").GetString();
            string? name = el.GetProperty("name").GetString();
            long size = el.GetProperty("size").GetInt64();
            uint? crc32 =
                el.TryGetProperty("crc32", out JsonElement c) &&
                c.ValueKind == JsonValueKind.Number
                    ? c.GetUInt32()
                    : null;
            long updatedAt =
                el.TryGetProperty("updatedAt", out JsonElement u) &&
                u.ValueKind == JsonValueKind.Number
                    ? u.GetInt64()
                    : 0;
            if (identity is not { Length: 32 } || identity.Any(ch => !Uri.IsHexDigit(ch)))
            {
                return null;
            }
            if (digest is not { Length: 64 } || digest.Any(ch => !Uri.IsHexDigit(ch)))
            {
                return null;
            }
            if (kind is not ("file" or "bundle"))
            {
                return null;
            }
            // Records must stay inside the target folder: plain relative names
            // only — reject anything path-shaped.
            if (string.IsNullOrEmpty(savedName) ||
                Path.GetFileName(savedName) != savedName)
            {
                return null;
            }
            if (name is null || size <= 0)
            {
                return null;
            }
            return new IndexEntry(
                identity, digest, kind, savedName, name, size, crc32, updatedAt);
        }
        catch
        {
            return null;
        }
    }

    private void AddEntry(IndexEntry entry)
    {
        _entries.RemoveAll(e => e.Identity == entry.Identity);
        _entries.Add(entry);
        _transferIdentity[entry.Identity] = entry.Digest;
        _saved[entry.Digest] = new SavedRecord(
            Path.Combine(_dir, entry.SavedName), entry.Kind == "bundle");
        if (entry.Crc32 is uint crc)
        {
            _byTriple[new TripleKey(entry.Name, entry.Size, crc)] = entry.Digest;
        }
    }

    private void EvictOverflow()
    {
        while (_entries.Count > MaxIndexEntries)
        {
            int oldest = 0;
            for (int i = 1; i < _entries.Count; i++)
            {
                if (_entries[i].UpdatedAt < _entries[oldest].UpdatedAt)
                {
                    oldest = i;
                }
            }
            IndexEntry victim = _entries[oldest];
            _entries.RemoveAt(oldest);
            _transferIdentity.Remove(victim.Identity);
            if (victim.Crc32 is uint crc)
            {
                _byTriple.Remove(new TripleKey(victim.Name, victim.Size, crc));
            }
            // _saved keeps the digest record: it costs nothing and is always
            // re-verified against the folder's actual bytes before use.
        }
    }

    /// <summary>
    /// Persist the dedup records atomically (temp + flush-to-disk + rename).
    /// Best-effort: the folder may be read-only or a removable drive that was
    /// unplugged — a failed write never fails the save; in-memory dedup keeps
    /// working for the rest of the run.
    /// </summary>
    private void PersistIndex()
    {
        try
        {
            var payload = new
            {
                version = 1,
                entries = _entries.Select(e => new
                {
                    identity = e.Identity,
                    digest = e.Digest,
                    kind = e.Kind,
                    savedName = e.SavedName,
                    name = e.Name,
                    size = e.Size,
                    crc32 = e.Crc32,
                    updatedAt = e.UpdatedAt,
                }).ToArray(),
            };
            WriteAtomic(
                Path.Combine(_dir, IndexFileName),
                JsonSerializer.SerializeToUtf8Bytes(payload));
        }
        catch
        {
            // Best-effort — see the doc above.
        }
    }

    private string UniqueDir(string name)
    {
        string first = Path.Combine(_dir, name);
        if (!Directory.Exists(first) && !File.Exists(first))
        {
            return first;
        }
        int i = 1;
        string candidate;
        do
        {
            candidate = Path.Combine(_dir, $"{name}({i})");
            i++;
        }
        while (Directory.Exists(candidate) || File.Exists(candidate));
        return candidate;
    }

    private static void TryDeleteDir(string dir)
    {
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
        }
        catch
        {
            // Best effort: a leftover .tmp staging dir is inert garbage.
        }
    }

    private static ContinuousSaveReport Skip(string name, long size, string hash) =>
        new(ContinuousSaveStatus.SkippedDuplicate, null, name, size, hash);

    private static string ContentStoreSha256(BundleFile file)
    {
        using Stream stream = file.OpenRead();
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string ContentStoreSha256(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static string HashFile(string path)
    {
        try
        {
            using FileStream stream = File.OpenRead(path);
            return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        }
        catch
        {
            return string.Empty;
        }
    }

    /// <summary>Deterministic digest over member names + contents (order kept).</summary>
    private static string BundleDigest(IReadOnlyList<BundleFile> files)
    {
        using IncrementalHash sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var len = new byte[8];
        foreach (BundleFile f in files)
        {
            BinaryPrimitives.WriteUInt64BigEndian(len, (ulong)f.Name.Length);
            sha.AppendData(len);
            sha.AppendData(Encoding.UTF8.GetBytes(f.Name));
            BinaryPrimitives.WriteUInt64BigEndian(len, (ulong)f.Size);
            sha.AppendData(len);
            using Stream input = f.OpenRead();
            byte[] buffer = new byte[1024 * 1024];
            int read;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                sha.AppendData(buffer.AsSpan(0, read));
            }
        }
        return Convert.ToHexString(sha.GetHashAndReset()).ToLowerInvariant();
    }

    private static void WriteAtomic(string path, BundleFile file)
    {
        string? dir = Path.GetDirectoryName(path);
        if (dir is null) throw new IOException("目标路径没有目录");
        Directory.CreateDirectory(dir);
        string temp = Path.Combine(dir, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            using Stream input = file.OpenRead();
            using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write,
                       FileShare.None, 1024 * 1024, FileOptions.WriteThrough))
            {
                input.CopyTo(output, 1024 * 1024);
                output.Flush(flushToDisk: true);
            }
            File.Move(temp, path, overwrite: false);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    private static void WriteAtomic(string path, byte[] bytes)
    {
        string? dir = Path.GetDirectoryName(path);
        if (dir is null) throw new IOException("目标路径没有目录");
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
}
