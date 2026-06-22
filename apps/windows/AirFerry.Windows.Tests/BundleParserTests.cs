using System.Buffers.Binary;
using System.Text;
using AirFerry.Windows.Bundle;
using Xunit;

namespace AirFerry.Windows.Tests;

/// <summary>
/// Verifies the multi-file bundle container parser. Mirrors the byte layout
/// the browser sender emits (<c>apps/sender/src/wasm/bundle.ts</c>) and the
/// Android parser (<c>BundleParser.kt</c>) checks against.
/// </summary>
public class BundleParserTests
{
    private static byte[] BuildBundle(params (string Name, byte[] Data)[] files)
    {
        using var ms = new MemoryStream();
        ms.Write("ETBUNDL1"u8);
        Span<byte> u16 = stackalloc byte[2];
        Span<byte> u64 = stackalloc byte[8];
        BinaryPrimitives.WriteUInt16BigEndian(u16, 1); // version
        ms.Write(u16);
        BinaryPrimitives.WriteUInt16BigEndian(u16, (ushort)files.Length);
        ms.Write(u16);
        foreach (var (name, data) in files)
        {
            byte[] nameBytes = Encoding.UTF8.GetBytes(name);
            BinaryPrimitives.WriteUInt16BigEndian(u16, (ushort)nameBytes.Length);
            ms.Write(u16);
            ms.Write(nameBytes);
            BinaryPrimitives.WriteUInt64BigEndian(u64, (ulong)data.Length);
            ms.Write(u64);
            ms.Write(data);
        }
        return ms.ToArray();
    }

    [Fact]
    public void IsBundle_DetectsMagic()
    {
        Assert.True(BundleParser.IsBundle(BuildBundle(("a.txt", [1, 2, 3]))));
        Assert.False(BundleParser.IsBundle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
        Assert.False(BundleParser.IsBundle([]));
    }

    [Fact]
    public void Parse_ValidBundle_ReadsAllFiles()
    {
        byte[] buf = BuildBundle(
            ("报告.txt", new byte[] { 0xDE, 0xAD }),
            ("world.bin", new byte[] { 1, 2, 3, 4, 5 }));
        var b = BundleParser.Parse(buf);
        Assert.NotNull(b);
        Assert.Equal(2, b!.Files.Count);
        Assert.Equal("报告.txt", b.Files[0].Name);
        Assert.Equal(new byte[] { 0xDE, 0xAD }, b.Files[0].Data);
        Assert.Equal("world.bin", b.Files[1].Name);
        Assert.Equal(5, b.Files[1].Data.Length);
    }

    [Fact]
    public void Parse_SingleFile_RoundTrips()
    {
        byte[] content = Encoding.UTF8.GetBytes("AirFerry payload");
        byte[] buf = BuildBundle(("only.dat", content));
        var b = BundleParser.Parse(buf);
        Assert.NotNull(b);
        Assert.Single(b!.Files);
        Assert.Equal(content, b.Files[0].Data);
    }

    [Fact]
    public void Parse_Rejects_BadMagic()
    {
        byte[] buf = BuildBundle(("a", [1]));
        buf[0] = (byte)'X'; // corrupt magic
        Assert.Null(BundleParser.Parse(buf));
    }

    [Fact]
    public void Parse_Rejects_BadVersion()
    {
        byte[] buf = BuildBundle(("a", [1]));
        BinaryPrimitives.WriteUInt16BigEndian(buf.AsSpan(8, 2), 999);
        Assert.Null(BundleParser.Parse(buf));
    }

    [Fact]
    public void Parse_Rejects_TruncatedEntry()
    {
        byte[] buf = BuildBundle(("a", [1, 2, 3]));
        // Claim 2 files but only provide 1.
        BinaryPrimitives.WriteUInt16BigEndian(buf.AsSpan(10, 2), 2);
        Assert.Null(BundleParser.Parse(buf));
    }

    [Fact]
    public void Parse_Rejects_SizeBeyondBuffer()
    {
        byte[] buf = BuildBundle(("a", [1]));
        // Inflate the declared size to exceed the remaining buffer.
        BinaryPrimitives.WriteUInt64BigEndian(buf.AsSpan(15, 8), ulong.MaxValue);
        Assert.Null(BundleParser.Parse(buf));
    }
}
