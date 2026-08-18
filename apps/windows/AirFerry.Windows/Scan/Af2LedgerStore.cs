using System.IO;
using System.Text;
using System.Text.Json;

namespace AirFerry.Windows.Scan;

/// <summary>
/// Crash-safe §12 resume ledger — the journal twin of <see cref="ChunkSpillStore"/>'s
/// <c>.partial</c> file. JSONL, one file per transfer (<c>af2-&lt;tid&gt;.ledger.jsonl</c>):
/// <para>
/// Line 1 (header): <c>{"v":1,"tid":…,"root":…,"crs":…}</c> — written atomically
/// (temp + flush + rename) before the first chunk commit. Each later line is
/// <c>{"c":i}</c> (chunk committed after its bytes were pwrite+fsync'd into the
/// spill) or <c>{"i":i}</c> (chunk invalidated after a re-verification failure).
/// A torn tail line fails JSON parsing and is skipped, so the journal never
/// reports more than what reached the disk.
/// </para>
/// <para>
/// Only touched from the pool's serialized ingest callback (under
/// <c>IngestLock</c>) and the recovery core that runs under the same lock.
/// </para>
/// </summary>
public sealed class Af2LedgerStore
{
    private readonly string _path;
    public string TransferIdHex { get; private set; } = "";
    public int ChunkRawSize { get; private set; }
    public byte[] RootFrameBytes { get; private set; } = Array.Empty<byte>();
    public SortedSet<int> Completed { get; } = new();

    private Af2LedgerStore(string path)
    {
        _path = path;
    }

    /// <summary>True once the header line is durably on disk (set by Create).</summary>
    private bool _headerDurable;

    public int[] CompletedIndices => Completed.ToArray();

    /// <summary>Parse (or re-parse) the journal. True when a valid header exists.</summary>
    public bool Reload()
    {
        Completed.Clear();
        if (!File.Exists(_path))
        {
            return false;
        }
        string[] lines;
        try
        {
            lines = File.ReadAllLines(_path);
        }
        catch (IOException)
        {
            return false;
        }
        bool headerSeen = false;
        foreach (string line in lines)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }
            JsonElement o;
            try
            {
                using JsonDocument doc = JsonDocument.Parse(line);
                o = doc.RootElement.Clone();
            }
            catch (JsonException)
            {
                continue; // torn tail line from a mid-write crash
            }
            if (!headerSeen)
            {
                if (!o.TryGetProperty("v", out _))
                {
                    continue;
                }
                TransferIdHex = o.TryGetProperty("tid", out JsonElement tid) ? tid.GetString() ?? "" : "";
                ChunkRawSize = o.TryGetProperty("crs", out JsonElement crs) && crs.TryGetInt32(out int crsVal)
                    ? crsVal : 0;
                RootFrameBytes = o.TryGetProperty("root", out JsonElement root)
                    ? HexToBytes(root.GetString() ?? "") : Array.Empty<byte>();
                headerSeen = true;
                continue;
            }
            if (o.TryGetProperty("c", out JsonElement c) && c.TryGetInt32(out int ci))
            {
                Completed.Add(ci);
            }
            if (o.TryGetProperty("i", out JsonElement inv) && inv.TryGetInt32(out int ii))
            {
                Completed.Remove(ii);
            }
        }
        // A journal that reloads with a valid header is durable by definition —
        // resumed transfers keep appending to it.
        _headerDurable = headerSeen &&
            !string.IsNullOrEmpty(TransferIdHex) &&
            RootFrameBytes.Length > 0;
        return _headerDurable;
    }

    /// <summary>Append one commit event (after the chunk was spilled + flushed).</summary>
    public void Commit(int index)
    {
        if (!_headerDurable) return; // headerless journal would never reload
        AppendLine($"{{\"c\":{index}}}");
        Completed.Add(index);
    }

    /// <summary>Append one invalidate event (after a re-verification failure).</summary>
    public void Invalidate(int index)
    {
        if (!_headerDurable) return;
        AppendLine($"{{\"i\":{index}}}");
        Completed.Remove(index);
    }

    private void AppendLine(string json)
    {
        try
        {
            using var fs = new FileStream(
                _path, FileMode.Append, FileAccess.Write, FileShare.None);
            byte[] bytes = Encoding.UTF8.GetBytes(json + "\n");
            fs.Write(bytes, 0, bytes.Length);
            fs.Flush(flushToDisk: true);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[Af2LedgerStore] append failed: {ex.Message}");
        }
    }

    /// <summary>Delete the journal (transfer finished / relocked away / abandoned).</summary>
    public void Discard()
    {
        try { File.Delete(_path); } catch (IOException) { }
    }

    public record PendingTransfer(
        string TransferIdHex,
        int ChunkRawSize,
        int CompletedCount,
        long DiskBytes,
        DateTime LastModified);

    /// <summary>List all pending/uncompleted transfer ledgers in <paramref name="dir"/>.</summary>
    public static IReadOnlyList<PendingTransfer> ListPendingTransfers(string dir)
    {
        if (!Directory.Exists(dir)) return [];
        try
        {
            var list = new List<PendingTransfer>();
            foreach (var file in Directory.EnumerateFiles(dir, "af2-*.ledger.jsonl"))
            {
                var store = new Af2LedgerStore(file);
                if (store.Reload())
                {
                    string tid = store.TransferIdHex;
                    string spill = Path.Combine(dir, $"af2-{tid}.partial");
                    long spillBytes = File.Exists(spill) ? new FileInfo(spill).Length : 0L;
                    var fi = new FileInfo(file);
                    list.Add(new PendingTransfer(
                        tid,
                        store.ChunkRawSize,
                        store.CompletedIndices.Length,
                        fi.Length + spillBytes,
                        fi.LastWriteTime));
                }
            }
            return list.OrderByDescending(p => p.LastModified).ToList();
        }
        catch (Exception)
        {
            return [];
        }
    }

    /// <summary>Discard all pending journals, spills, and temp files in <paramref name="dir"/>.</summary>
    public static void DiscardAllPending(string dir)
    {
        if (!Directory.Exists(dir)) return;
        try
        {
            foreach (var f in Directory.EnumerateFiles(dir, "af2-*"))
            {
                if (f.EndsWith(".ledger.jsonl") || f.EndsWith(".partial") || f.EndsWith(".tmp"))
                {
                    try { File.Delete(f); } catch { }
                }
            }
        }
        catch { }
    }

    /// <summary>Resume source: the newest valid journal in <paramref name="dir"/>.</summary>
    public static Af2LedgerStore? LoadMostRecent(string dir)
    {
        try
        {
            if (!Directory.Exists(dir))
            {
                return null;
            }
            foreach (FileInfo candidate in new DirectoryInfo(dir)
                         .EnumerateFiles("*.ledger.jsonl")
                         .OrderByDescending(f => f.LastWriteTimeUtc))
            {
                var store = new Af2LedgerStore(candidate.FullName);
                if (store.Reload()) return store;
            }
            return null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Remove spill files that have no parseable resume journal.</summary>
    public static void SweepOrphanPartials(string dir)
    {
        if (!Directory.Exists(dir)) return;
        try
        {
            var validTids = new HashSet<string>(StringComparer.Ordinal);
            foreach (string journal in Directory.EnumerateFiles(dir, "*.ledger.jsonl"))
            {
                var store = new Af2LedgerStore(journal);
                if (store.Reload())
                {
                    validTids.Add(store.TransferIdHex);
                }
                else
                {
                    try { File.Delete(journal); } catch { }
                }
            }
            foreach (string partial in Directory.EnumerateFiles(dir, "af2-*.partial"))
            {
                string name = Path.GetFileName(partial);
                string tid = name.Substring(4, name.Length - 4 - ".partial".Length);
                if (!validTids.Contains(tid))
                {
                    try { File.Delete(partial); } catch { }
                }
            }
        }
        catch { }
    }

    /// <summary>Create + atomically write the header for a fresh transfer's journal.</summary>
    public static Af2LedgerStore Create(
        string dir, string transferIdHex, int chunkRawSize, byte[] rootFrameBytes)
    {
        string id = string.IsNullOrEmpty(transferIdHex) ? "session" : transferIdHex;
        string path = Path.Combine(dir, $"af2-{id}.ledger.jsonl");
        try { File.Delete(path); } catch (IOException) { }
        string header = JsonSerializer.Serialize(new
        {
            v = 1,
            tid = transferIdHex,
            crs = chunkRawSize,
            root = BytesToHex(rootFrameBytes),
        });
        bool headerDurable = false;
        try
        {
            Directory.CreateDirectory(dir);
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, header + "\n");
            File.Move(tmp, path, overwrite: true);
            headerDurable = true;
        }
        catch (Exception ex)
        {
            // A journal whose header never became durable is permanently
            // un-reloadable (Reload requires a header line) and the resume
            // sweep would delete its spill as garbage. Keep the store for the
            // in-memory completed-set, but refuse to append so we never write
            // a headerless {"c":i} journal that silently breaks §12 resume.
            System.Diagnostics.Debug.WriteLine($"[Af2LedgerStore] header write failed: {ex.Message}");
        }
        return new Af2LedgerStore(path)
        {
            TransferIdHex = transferIdHex,
            ChunkRawSize = chunkRawSize,
            RootFrameBytes = rootFrameBytes,
            _headerDurable = headerDurable,
        };
    }

    private static string BytesToHex(byte[] b)
    {
        var sb = new StringBuilder(b.Length * 2);
        foreach (byte x in b)
        {
            sb.Append(x.ToString("x2"));
        }
        return sb.ToString();
    }

    private static byte[] HexToBytes(string s)
    {
        if (s.Length == 0 || s.Length % 2 != 0)
        {
            return Array.Empty<byte>();
        }
        var outBytes = new byte[s.Length / 2];
        for (int i = 0; i < outBytes.Length; i++)
        {
            outBytes[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
        }
        return outBytes;
    }
}
