using System.Buffers.Binary;
using System.Text;

namespace AirFerry.Windows.Bundle;

/// <summary>One file inside a multi-file bundle.</summary>
public sealed class BundleFile(string name, byte[] data)
{
    public string Name { get; } = name;
    public byte[] Data { get; } = data;
}

/// <summary>A parsed multi-file bundle container.</summary>
public sealed class Bundle(IReadOnlyList<BundleFile> files)
{
    public IReadOnlyList<BundleFile> Files { get; } = files;
}

/// <summary>
/// Multi-file bundle container parser — mirrors the browser sender's
/// <c>bundle.ts</c> byte-for-byte so the two sides stay interoperable.
/// </summary>
/// <remarks>
/// Wire layout (big-endian):
/// <code>
/// offset  size   field
/// 0       8      magic: ASCII "ETBUNDL1"
/// 8       2      version: u16 = 1
/// 10      2      file_count: u16
/// 12      …      file_count × { u16 name_len, name_len name UTF-8,
///                                u64 size, size content }
/// </code>
/// The sender only emits a bundle when ≥2 files are selected.
/// All parsing is bounds-checked and returns null on any malformed input.
/// </remarks>
public static class BundleParser
{
    public static ReadOnlySpan<byte> Magic => "ETBUNDL1"u8;

    /// <summary>True if bytes starts with the 8-byte bundle magic.</summary>
    public static bool IsBundle(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 12)
        {
            return false;
        }
        return bytes[..8].SequenceEqual(Magic);
    }

    /// <summary>
    /// Parse a bundle. Returns null on any structural problem (bad magic,
    /// truncated entry, declared length beyond the buffer).
    /// </summary>
    public static Bundle? Parse(ReadOnlySpan<byte> bytes)
    {
        if (!IsBundle(bytes))
        {
            return null;
        }
        int version = BinaryPrimitives.ReadUInt16BigEndian(bytes.Slice(8, 2));
        if (version != 1)
        {
            return null;
        }
        int count = BinaryPrimitives.ReadUInt16BigEndian(bytes.Slice(10, 2));
        if (count == 0)
        {
            return null;
        }

        var files = new BundleFile[count];
        int pos = 12;
        for (int i = 0; i < count; i++)
        {
            if (pos + 2 > bytes.Length)
            {
                return null;
            }
            int nameLen = BinaryPrimitives.ReadUInt16BigEndian(bytes.Slice(pos, 2));
            pos += 2;
            if (pos + nameLen + 8 > bytes.Length)
            {
                return null;
            }
            string name = Encoding.UTF8.GetString(bytes.Slice(pos, nameLen));
            pos += nameLen;
            long size = (long)BinaryPrimitives.ReadUInt64BigEndian(bytes.Slice(pos, 8));
            pos += 8;
            if (size < 0 || size > int.MaxValue)
            {
                return null;
            }
            if (pos + (int)size > bytes.Length)
            {
                return null;
            }
            byte[] data = bytes.Slice(pos, (int)size).ToArray();
            pos += (int)size;
            files[i] = new BundleFile(name, data);
        }
        return new Bundle(files);
    }
}
