using System.Buffers.Binary;
using AirFerry.Windows.Scan;
using Xunit;

namespace AirFerry.Windows.Tests;

/// <summary>
/// Guards the descriptor-v5 replay filter (issue #8): a stored segment that is
/// still on screen must never initialize the fresh receiver used for the next
/// segment, while frames from other sessions must still pass through.
/// </summary>
public class CompletedSegmentTrackerTests
{
    private static byte[] Frame(
        ulong sidLo, ulong sidHi, byte magic = 0x45, byte magic2 = 0x54,
        byte version = 1, byte flags = FrameHeader.FlagDescriptor)
    {
        byte[] frame = new byte[64];
        frame[0] = magic;
        frame[1] = magic2;
        frame[2] = version;
        frame[3] = flags;
        BinaryPrimitives.WriteUInt64BigEndian(frame.AsSpan(4, 8), sidHi);
        BinaryPrimitives.WriteUInt64BigEndian(frame.AsSpan(12, 8), sidLo);
        return frame;
    }

    [Fact]
    public void StoredSessionMatchesBothDescriptorAndDataFrames()
    {
        var tracker = new CompletedSegmentTracker();
        tracker.Add((0xAAAA_BBBB_CCCC_DDDDUL, 0x1111_2222_3333_4444UL));

        Assert.True(tracker.Contains(Frame(0xAAAA_BBBB_CCCC_DDDDUL,
            0x1111_2222_3333_4444UL, flags: FrameHeader.FlagDescriptor)));
        Assert.True(tracker.Contains(Frame(0xAAAA_BBBB_CCCC_DDDDUL,
            0x1111_2222_3333_4444UL, flags: 0)));
    }

    [Fact]
    public void DifferentSessionStillPassesThrough()
    {
        var tracker = new CompletedSegmentTracker();
        tracker.Add((1, 2));

        Assert.False(tracker.Contains(Frame(1, 3)));
        Assert.False(tracker.Contains(Frame(2, 1)));
        Assert.Equal(1, tracker.Count);
    }

    [Fact]
    public void InvalidAirFerryFramesNeverMatch()
    {
        var tracker = new CompletedSegmentTracker();
        tracker.Add((1, 2));

        // Wrong magic, wrong version and truncated payloads are not AirFerry
        // frames; unrelated QR codes on screen must not be mistaken for a
        // completed segment.
        Assert.False(tracker.Contains(Frame(1, 2, magic: 0x55)));
        Assert.False(tracker.Contains(Frame(1, 2, version: 2)));
        Assert.False(tracker.Contains(Frame(1, 2).AsSpan(0, 63)));
        Assert.False(tracker.Contains(ReadOnlySpan<byte>.Empty));
    }

    [Fact]
    public void ClearAndDuplicateAddsAreStable()
    {
        var tracker = new CompletedSegmentTracker();
        tracker.Add((7, 8));
        tracker.Add((7, 8));
        Assert.Equal(1, tracker.Count);

        tracker.Clear();
        Assert.Equal(0, tracker.Count);
        Assert.False(tracker.Contains(Frame(7, 8)));
    }
}
