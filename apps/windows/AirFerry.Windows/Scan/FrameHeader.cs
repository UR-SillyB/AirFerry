using System.Buffers.Binary;

namespace AirFerry.Windows.Scan;

/// <summary>
/// Parsed frame header (the subset of fields the host needs to drive the
/// session state machine). Mirrors <c>ReceiverSessionManager.kt::FrameHeader</c>
/// field-for-field; the authoritative wire layout lives in
/// <c>core/qr-protocol/src/frame.rs</c> (60-byte big-endian header + payload +
/// 4-byte footer).
/// </summary>
public readonly record struct FrameHeader(
    int Magic,
    int Version,
    int Flags,
    ulong SessionIdLo,
    ulong SessionIdHi,
    uint Sbn,
    uint Esi,
    uint TotalBlocks,
    uint TotalSymbols,
    uint SymbolSize)
{
    public const int MagicValue = 0x4554;     // 'ET' — wire magic.
    public const int ProtocolVersion = 1;
    public const int FlagDescriptor = 0x01;    // bit 0 of Flags.

    /// <summary>Minimum frame size: 60-byte header + 4-byte footer (payload may be 0).</summary>
    public const int MinFrameSize = 64;

    /// <summary>
    /// Parse + validate a frame's header. Returns <see langword="null"/> if the
    /// buffer is too short, the magic is wrong, or the version is unsupported.
    /// Full CRC verification is delegated to the Rust side (<c>Frame::from_bytes</c>
    /// inside <c>ReceiverIngest</c>) — the host only needs magic + version here.
    /// </summary>
    public static FrameHeader? Parse(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < MinFrameSize)
        {
            return null;
        }
        int magic = BinaryPrimitives.ReadUInt16BigEndian(bytes[..2]);
        if (magic != MagicValue)
        {
            return null;
        }
        int version = bytes[2];
        if (version != ProtocolVersion)
        {
            return null;
        }
        int flags = bytes[3];

        // The wire session_id is a 128-bit big-endian value at offset 4..20.
        // .NET has no u128, so split it into high/low 64-bit halves — exactly
        // how Kotlin splits it (no u128 in the JVM either).
        ulong sessionIdHi = BinaryPrimitives.ReadUInt64BigEndian(bytes.Slice(4, 8));
        ulong sessionIdLo = BinaryPrimitives.ReadUInt64BigEndian(bytes.Slice(12, 8));

        uint sbn = BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(20, 4));
        uint esi = BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(24, 4));
        uint totalBlocks = BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(28, 4));
        uint totalSymbols = BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(32, 4));
        uint symbolSize = BinaryPrimitives.ReadUInt32BigEndian(bytes.Slice(36, 4));

        return new FrameHeader(
            magic, version, flags, sessionIdLo, sessionIdHi,
            sbn, esi, totalBlocks, totalSymbols, symbolSize);
    }

    public bool IsDescriptor => (Flags & FlagDescriptor) != 0;
}
