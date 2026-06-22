using System.Buffers.Binary;
using AirFerry.Windows.Scan;
using Xunit;

namespace AirFerry.Windows.Tests;

/// <summary>
/// Verifies FrameHeader parsing against the authoritative wire layout in
/// <c>core/qr-protocol/src/frame.rs</c> (60-byte big-endian header). Mirrors
/// the same checks Kotlin's <c>parseHeader</c> must pass.
/// </summary>
public class FrameHeaderTests
{
    private static byte[] BuildHeader(ushort magic = 0x4554, byte version = 1,
        byte flags = 0, ulong sidHi = 0, ulong sidLo = 0xDEAD,
        uint sbn = 2, uint esi = 3, uint totalBlocks = 4, uint totalSymbols = 100,
        uint symbolSize = 1024)
    {
        // 60-byte header + 4-byte footer; we only need the header for parsing
        // (magic + version + flags + session_id + 4 u32 totals).
        byte[] buf = new byte[64];
        BinaryPrimitives.WriteUInt16BigEndian(buf.AsSpan(0, 2), magic);
        buf[2] = version;
        buf[3] = flags;
        BinaryPrimitives.WriteUInt64BigEndian(buf.AsSpan(4, 8), sidHi);
        BinaryPrimitives.WriteUInt64BigEndian(buf.AsSpan(12, 8), sidLo);
        BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(20, 4), sbn);
        BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(24, 4), esi);
        BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(28, 4), totalBlocks);
        BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(32, 4), totalSymbols);
        BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(36, 4), symbolSize);
        return buf;
    }

    [Fact]
    public void Parse_ValidHeader_ReadsAllFields()
    {
        byte[] buf = BuildHeader();
        var h = FrameHeader.Parse(buf);
        Assert.NotNull(h);
        Assert.Equal(0x4554, h!.Magic);
        Assert.Equal(1, h.Version);
        Assert.Equal(0, h.Flags);
        Assert.Equal(0xDEADul, h.SessionIdLo);
        Assert.Equal(0ul, h.SessionIdHi);
        Assert.Equal(2u, h.Sbn);
        Assert.Equal(3u, h.Esi);
        Assert.Equal(4u, h.TotalBlocks);
        Assert.Equal(100u, h.TotalSymbols);
        Assert.Equal(1024u, h.SymbolSize);
        Assert.False(h.IsDescriptor);
    }

    [Fact]
    public void Parse_DescriptorFlag_Detected()
    {
        byte[] buf = BuildHeader(flags: 0x01);
        var h = FrameHeader.Parse(buf);
        Assert.NotNull(h);
        Assert.True(h!.IsDescriptor);
        // Other flag bits must not affect IsDescriptor (only bit 0 matters).
        h = FrameHeader.Parse(BuildHeader(flags: 0x02));
        Assert.False(h!.IsDescriptor);
    }

    [Fact]
    public void Parse_SessionId_SplitsIntoHiLoHalves()
    {
        // 128-bit session id = hi(0x1111222233334444) || lo(0x5555666677778888).
        byte[] buf = BuildHeader(sidHi: 0x1111222233334444, sidLo: 0x5555666677778888);
        var h = FrameHeader.Parse(buf);
        Assert.NotNull(h);
        Assert.Equal(0x1111222233334444ul, h!.SessionIdHi);
        Assert.Equal(0x5555666677778888ul, h.SessionIdLo);
    }

    [Fact]
    public void Parse_Rejects_BadMagic()
    {
        Assert.Null(FrameHeader.Parse(BuildHeader(magic: 0x1234)));
    }

    [Fact]
    public void Parse_Rejects_BadVersion()
    {
        Assert.Null(FrameHeader.Parse(BuildHeader(version: 99)));
    }

    [Fact]
    public void Parse_Rejects_TooShortBuffer()
    {
        Assert.Null(FrameHeader.Parse(new byte[63]));
        // 64 is the minimum (60-byte header + 4-byte footer slot).
        Assert.NotNull(FrameHeader.Parse(new byte[64]));
    }
}
