namespace AirFerry.Windows.Scan;

/// <summary>
/// Lightweight per-frame status decoded from the native <c>ReceiverIngest</c>
/// packed <see cref="ulong"/>. Carries only what the ingest path needs
/// (completion + re-init heuristics); the full progress is fetched on demand
/// via <see cref="ReceiverSession.Progress"/> at the UI cadence.
/// </summary>
/// <remarks>
/// Mirrors <c>ReceiverSessionManager.kt::IngestStatus</c> bit-for-bit, which in
/// turn mirrors <c>cffi.rs::pack_ingest_status</c> /
/// <c>jni.rs::pack_ingest_status</c>. All three hosts must stay byte-aligned.
/// </remarks>
public readonly record struct IngestStatus(
    bool Complete,
    bool Accepted,
    int MismatchStreak,
    int ReceivedSymbols)
{
    /// <summary>
    /// Decode a packed status word, or <see langword="null"/> on the error
    /// sentinel (<c>received_symbols == u32::MAX</c>).
    /// </summary>
    public static IngestStatus? Unpack(ulong word)
    {
        // Error sentinel: received_symbols field (bits 32..63) == 0xFFFFFFFF.
        uint receivedField = (uint)(word >> 32);
        if (receivedField == 0xFFFF_FFFFu)
        {
            return null;
        }

        bool complete = (word & 1u) != 0u;
        bool accepted = ((word >> 1) & 1u) != 0u;
        int streak = (int)((word >> 8) & 0xFFFFu);
        int received = (int)receivedField;
        return new IngestStatus(complete, accepted, streak, received);
    }
}
