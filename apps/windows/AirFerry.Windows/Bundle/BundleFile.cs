using System.IO;

namespace AirFerry.Windows.Bundle;

/// <summary>
/// One recovered multi-entry file (AF2 Manifest bundle member): its wire path
/// and raw content slice. Successor of the v1 BundleParser member type —
/// the parser is gone (F2 v1-artifact removal), the recovered-file pipeline
/// (continuous save / share export) still flows through this shape.
/// </summary>
public sealed record BundleFile
{
    private readonly byte[]? _data;

    public BundleFile(string name, byte[] data)
    {
        Name = name;
        _data = data ?? throw new ArgumentNullException(nameof(data));
        Size = data.LongLength;
    }

    public BundleFile(string name, string storedPath, long size)
    {
        if (size < 0) throw new ArgumentOutOfRangeException(nameof(size));
        Name = name;
        StoredPath = storedPath ?? throw new ArgumentNullException(nameof(storedPath));
        Size = size;
    }

    public string Name { get; }
    public string? StoredPath { get; }
    public long Size { get; }

    /// <summary>
    /// Compatibility accessor for small text-preview callers. Path-backed
    /// large bundle members must use <see cref="OpenRead"/> / <see cref="CopyTo"/>
    /// so they never materialize the whole file in managed memory.
    /// </summary>
    public byte[] Data => _data ?? File.ReadAllBytes(
        StoredPath ?? throw new InvalidOperationException("Bundle member has no backing data"));

    public Stream OpenRead()
    {
        if (_data is not null)
        {
            return new MemoryStream(_data, writable: false);
        }
        return new FileStream(
            StoredPath ?? throw new InvalidOperationException("Bundle member has no backing file"),
            FileMode.Open, FileAccess.Read, FileShare.Read,
            1024 * 1024, FileOptions.SequentialScan);
    }

    public void CopyTo(string targetPath)
    {
        string? dir = Path.GetDirectoryName(targetPath);
        if (dir is not null) Directory.CreateDirectory(dir);
        using Stream input = OpenRead();
        using var output = new FileStream(
            targetPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
            1024 * 1024, FileOptions.SequentialScan | FileOptions.WriteThrough);
        input.CopyTo(output, 1024 * 1024);
        output.Flush(flushToDisk: true);
    }
}
