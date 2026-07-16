using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AirFerry.Windows.ViewModels;

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

    public static string RootDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            "AirFerry", "store");

    private static string IndexPath => Path.Combine(RootDir, "index.json");

    public static string BlobPath(string hash)
    {
        string h = hash.ToLowerInvariant();
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
        lock (Gate)
        {
            Directory.CreateDirectory(RootDir);
            string hash = Sha256Hex(bytes);
            string path = BlobPath(hash);
            bool deduped = File.Exists(path) && new FileInfo(path).Length == bytes.LongLength;
            if (!deduped)
            {
                File.WriteAllBytes(path, bytes);
            }
            var entry = new Entry(
                Id: Guid.NewGuid().ToString("N"),
                Name: FileNameUtil.Sanitize(displayName),
                Hash: hash,
                Size: bytes.LongLength,
                CrcHex: crcHex,
                CrcUnknown: crcUnknown,
                Kind: kind,
                CreatedAt: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                BundleId: bundleId,
                BundleTitle: bundleTitle);
            var all = LoadIndex();
            all.Add(entry);
            SaveIndex(all);
            return new PutResult(entry, path, deduped);
        }
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
        }
    }

    /// <summary>Import legacy Documents/AirFerry/received once if store is empty.</summary>
    public static void MigrateLegacyReceivedIfNeeded()
    {
        lock (Gate)
        {
            if (LoadIndex().Count > 0) return;
            string legacy = ScanViewModel.ReceivedDir;
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
            return JsonSerializer.Deserialize<List<Entry>>(json, JsonOpts) ?? [];
        }
        catch
        {
            return [];
        }
    }

    private static void SaveIndex(List<Entry> entries)
    {
        Directory.CreateDirectory(RootDir);
        string json = JsonSerializer.Serialize(entries, JsonOpts);
        File.WriteAllText(IndexPath, json, Encoding.UTF8);
    }
}
