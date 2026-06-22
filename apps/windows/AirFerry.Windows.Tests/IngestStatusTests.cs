using AirFerry.Windows.Scan;
using Xunit;

namespace AirFerry.Windows.Tests;

/// <summary>
/// Verifies the IngestStatus packed-word bit layout. These tests mirror the
/// Rust <c>cffi::tests::pack_status_bit_layout</c> and Kotlin's contract so all
/// three hosts agree byte-for-byte.
/// </summary>
public class IngestStatusTests
{
    private const ulong IngestError = 0xFFFF_FFFFuL << 32;

    [Fact]
    public void Unpack_Layout_Bit0Complete_Bit1Accepted()
    {
        Assert.Equal(default(IngestStatus), IngestStatus.Unpack(0));
        IngestStatus s = IngestStatus.Unpack(1).Value;
        Assert.True(s.Complete);
        Assert.False(s.Accepted);
        s = IngestStatus.Unpack(1uL << 1).Value;
        Assert.False(s.Complete);
        Assert.True(s.Accepted);
        s = IngestStatus.Unpack(0b11).Value;
        Assert.True(s.Complete);
        Assert.True(s.Accepted);
    }

    [Fact]
    public void Unpack_Layout_Bits8to23_MismatchStreak()
    {
        Assert.Equal(1, IngestStatus.Unpack(1uL << 8).Value.MismatchStreak);
        Assert.Equal(0xFFFF, IngestStatus.Unpack(0xFFFFuL << 8).Value.MismatchStreak);
        // Streak field is 16 bits — higher bits are the received field, not streak.
        IngestStatus s = IngestStatus.Unpack(0x12345uL << 8).Value;
        Assert.Equal(0x2345, s.MismatchStreak);
    }

    [Fact]
    public void Unpack_Layout_Bits32to63_ReceivedSymbols()
    {
        Assert.Equal(1, IngestStatus.Unpack(1uL << 32).Value.ReceivedSymbols);
        IngestStatus s = IngestStatus.Unpack(0b11 | (0x1234uL << 8) | (0x5678uL << 32)).Value;
        Assert.True(s.Complete);
        Assert.True(s.Accepted);
        Assert.Equal(0x1234, s.MismatchStreak);
        Assert.Equal(0x5678, s.ReceivedSymbols);
    }

    [Fact]
    public void Unpack_ErrorSentinel_ReturnsNull()
    {
        Assert.Null(IngestStatus.Unpack(IngestError));
    }
}
