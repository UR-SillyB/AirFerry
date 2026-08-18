using System.IO;

namespace AirFerry.Windows.Scan;

/// <summary>
/// Sparse on-disk staging for completed AF2 chunks — the receiver-side half of
/// the bounded-memory ledger (plan E2), the C# twin of Android's
/// <c>ChunkSpillStore.kt</c>.
/// <para>
/// Completed chunks are RAW (post-decode, post-decompress) and fixed-size
/// except the last, so the spill file's layout IS the canonical content
/// stream: chunk <c>i</c> lives at byte offset <c>i * chunkRawSize</c>. The
/// file is then read at recovery time so the full stream never has to exist
/// in native memory — chunks are evicted (<c>ReceiverForgetChunk</c>) as soon
/// as they are spilled.
/// </para>
/// <para>
/// Only ever touched from the pool's serialized ingest callback (under
/// <c>IngestLock</c>) and the recovery core that runs under the same lock, so
/// a single <see cref="FileStream"/> needs no extra synchronization. Every
/// open uses <c>FileAccess.ReadWrite</c> on the cached handle — a read-only
/// handle cached by a read path (e.g. resume re-verification) would poison
/// all later <see cref="Write"/> calls with <c>NotSupportedException</c>.
/// </para>
/// </summary>
public sealed class ChunkSpillStore : IDisposable
{
    private readonly string _path;
    private FileStream? _stream;
    /// <summary>
    /// Chunk indices known to hold spilled bytes: written this session or
    /// resumed via <see cref="MarkResumed"/>. The spill is a sparse file, so
    /// its LENGTH cannot prove completeness (holes read as zeros) — recovery
    /// consults this set before trusting a range.
    /// </summary>
    private readonly HashSet<int> _knownChunks = new();

    public ChunkSpillStore(string dir, string transferIdHex, bool deleteExisting = true)
    {
        Directory.CreateDirectory(dir);
        string id = string.IsNullOrEmpty(transferIdHex) ? "session" : transferIdHex;
        _path = Path.Combine(dir, $"af2-{id}.partial");
        // A same-id orphan from an earlier attempt must not leak bytes into
        // this transfer's stream — EXCEPT on §12 resume, where the existing
        // file IS this transfer's durable chunk data and must survive.
        if (deleteExisting)
        {
            try { File.Delete(_path); } catch (IOException) { }
        }
    }

    /// <summary>pwrite one completed chunk at its canonical-stream offset.</summary>
    public void Write(int index, int chunkRawSize, byte[] bytes)
    {
        if (index < 0 || chunkRawSize <= 0 || bytes.Length == 0)
        {
            throw new ArgumentOutOfRangeException(nameof(index), "invalid spill chunk");
        }
        FileStream fs = _stream ??= new FileStream(
            _path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        fs.Seek((long)index * chunkRawSize, SeekOrigin.Begin);
        fs.Write(bytes, 0, bytes.Length);
        // §12 durability invariant: the caller may journal + evict the native
        // chunk only after this returns. A Flush(true) failure must propagate.
        fs.Flush(true);
        _knownChunks.Add(index);
    }

    /// <summary>Current spill size in bytes (0 when nothing was spilled yet).</summary>
    public long Length()
    {
        if (_stream is not null)
        {
            return _stream.Length;
        }
        return File.Exists(_path) ? new FileInfo(_path).Length : 0L;
    }

    /// <summary>
    /// Read the whole canonical stream back (recovery time). Returns
    /// <see langword="null"/> when the spill is shorter than
    /// <paramref name="totalRawSize"/> (incomplete) — callers then fall back to
    /// the native assemble path.
    /// </summary>
    public byte[]? ReadAll(ulong totalRawSize)
    {
        if (totalRawSize == 0 || totalRawSize > int.MaxValue)
        {
            return null;
        }
        if (_stream is null && !File.Exists(_path))
        {
            return null;
        }
        FileStream fs;
        try
        {
            fs = _stream ??= new FileStream(
                _path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException)
        {
            return null;
        }
        if ((ulong)fs.Length < totalRawSize)
        {
            return null;
        }
        var buf = new byte[totalRawSize];
        int done = 0;
        while (done < buf.Length)
        {
            int n = fs.Read(buf, done, buf.Length - done);
            if (n <= 0)
            {
                return null;
            }
            done += n;
        }
        return buf;
    }

    /// <summary>
    /// Stream one canonical range into a destination file with bounded memory.
    /// The partial destination is removed on failure.
    /// </summary>
    public bool CopyRangeToFile(long offset, long size, string destinationPath,
        int bufferSize = 1024 * 1024)
    {
        if (offset < 0 || size < 0 || bufferSize <= 0)
        {
            return false;
        }
        if (_stream is null && !File.Exists(_path))
        {
            return false;
        }
        FileStream fs;
        try
        {
            fs = _stream ??= new FileStream(
                _path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException)
        {
            return false;
        }
        if (offset > fs.Length || size > fs.Length - offset)
        {
            return false;
        }
        string? dir = Path.GetDirectoryName(destinationPath);
        if (dir is not null) Directory.CreateDirectory(dir);
        try
        {
            fs.Seek(offset, SeekOrigin.Begin);
            using var output = new FileStream(
                destinationPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                bufferSize, FileOptions.SequentialScan | FileOptions.WriteThrough);
            byte[] buffer = new byte[(int)Math.Min((long)bufferSize, Math.Max(1L, size))];
            long remaining = size;
            while (remaining > 0)
            {
                int want = (int)Math.Min(buffer.Length, remaining);
                int read = fs.Read(buffer, 0, want);
                if (read <= 0) throw new EndOfStreamException("spill range truncated");
                output.Write(buffer, 0, read);
                remaining -= read;
            }
            output.Flush(flushToDisk: true);
            return new FileInfo(destinationPath).Length == size;
        }
        catch
        {
            try { File.Delete(destinationPath); } catch { }
            return false;
        }
    }

    /// <summary>Does this chunk hold spilled bytes (written or resumed)?</summary>
    public bool HasChunk(int index) => _knownChunks.Contains(index);

    /// <summary>Register chunks a §12 resume knows are durable in the spill.</summary>
    public void MarkResumed(IEnumerable<int> indices)
    {
        foreach (int i in indices)
        {
            _knownChunks.Add(i);
        }
    }

    /// <summary>Close and delete the spill (relocked / consumed / abandoned).</summary>
    public void Discard()
    {
        try { _stream?.Dispose(); } catch (IOException) { }
        _stream = null;
        _knownChunks.Clear();
        try { File.Delete(_path); } catch (IOException) { }
    }

    /// <summary>
    /// Read one canonical-stream range (§12 reopen re-verification reads
    /// individual chunks back). Returns null when the spill is shorter than
    /// the requested range end.
    /// </summary>
    public byte[]? ReadRange(long offset, long size)
    {
        if (offset < 0 || size < 0 || size > int.MaxValue)
        {
            return null;
        }
        if (_stream is null && !File.Exists(_path))
        {
            return null;
        }
        FileStream fs;
        try
        {
            fs = _stream ??= new FileStream(
                _path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException)
        {
            return null;
        }
        if (offset + size > fs.Length)
        {
            return null;
        }
        var buf = new byte[size];
        fs.Seek(offset, SeekOrigin.Begin);
        int done = 0;
        while (done < buf.Length)
        {
            int n = fs.Read(buf, done, buf.Length - done);
            if (n <= 0)
            {
                return null;
            }
            done += n;
        }
        return buf;
    }

    public void Dispose() => Discard();
}
