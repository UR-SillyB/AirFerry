namespace AirFerry.Windows.Scan;

/// <summary>
/// Remembers the child-session ids of descriptor-v5 segments that this scan
/// has already stored in the disk assembler.
/// </summary>
/// <remarks>
/// After a segment is archived the scanner swaps in a fresh receiver so the
/// *next* segment can initialize. The sender keeps replaying the completed
/// segment until the operator advances, so without this filter the fresh
/// receiver re-initializes to the old segment and receives it again — the
/// progress bar falls back to 0 and the next segment never initializes
/// (issue #8). Frames are only matched when they carry a valid AirFerry frame
/// header, so unrelated QR codes on screen cannot poison the filter.
/// </remarks>
public sealed class CompletedSegmentTracker
{
    private readonly HashSet<(ulong Lo, ulong Hi)> _ids = new();

    public int Count
    {
        get { lock (_ids) return _ids.Count; }
    }

    public void Clear()
    {
        lock (_ids) _ids.Clear();
    }

    /// <summary>Remember a stored segment. Duplicate adds are ignored.</summary>
    public void Add((ulong Lo, ulong Hi) sessionId)
    {
        lock (_ids) _ids.Add(sessionId);
    }

    /// <summary>True when the frame belongs to an already stored segment.</summary>
    public bool Contains(ReadOnlySpan<byte> frame)
    {
        FrameHeader? header = FrameHeader.Parse(frame);
        if (header is not { } parsed)
        {
            return false;
        }
        lock (_ids) return _ids.Contains((parsed.SessionIdLo, parsed.SessionIdHi));
    }
}
