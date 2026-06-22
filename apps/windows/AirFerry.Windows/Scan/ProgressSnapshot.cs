using System.Text.Json;

namespace AirFerry.Windows.Scan;

/// <summary>
/// Full progress snapshot parsed from the on-demand JSON returned by
/// <c>ReceiverProgressJson</c>. Mirrors <c>ReceiverSessionManager.kt::Progress</c>
/// field-for-field; the JSON keys are emitted by <c>cffi.rs::progress_json</c>
/// (identical to <c>jni.rs::progress_json</c>).
/// </summary>
/// <remarks>
/// Intended to be fetched at the UI refresh cadence (~7 Hz), NOT per-frame —
/// per-frame status uses the cheaper packed <see cref="IngestStatus"/> word.
/// </remarks>
public readonly record struct ProgressSnapshot(
    int DecodedSymbols,
    int TotalSymbols,
    int ReceivedSymbols,
    long FramesSeen,
    long FramesDropped,   // frames_duplicate + frames_corrupt (see Parse).
    long FramesCorrupt,
    int DecodedBlocks,
    int TotalBlocks,
    double DecodedFraction,
    double LossRatio,
    bool Complete,
    bool MetaConfirmed,
    int SessionMismatchStreak)
{
    /// <summary>
    /// Parse the progress JSON. Uses <see cref="JsonDocument"/> (zero shared
    /// state, pooled buffers) rather than a generated context, because the
    /// schema is tiny and stable.
    /// </summary>
    public static ProgressSnapshot Parse(string json)
    {
        using JsonDocument doc = JsonDocument.Parse(json);
        JsonElement root = doc.RootElement;
        long framesDuplicate = root.GetLong("frames_duplicate");
        long framesCorrupt = root.GetLong("frames_corrupt");
        return new ProgressSnapshot(
            DecodedSymbols: root.GetInt("decoded_symbols"),
            TotalSymbols: root.GetInt("total_symbols"),
            ReceivedSymbols: root.GetInt("received_symbols"),
            FramesSeen: root.GetLong("frames_seen"),
            // The Rust JSON emits frames_duplicate + frames_corrupt separately
            // (no frames_dropped key). Treat "dropped" as their union — every
            // seen frame that contributed no new data — which is what the
            // loss_ratio already reflects. Same convention as the Kotlin side.
            FramesDropped: framesDuplicate + framesCorrupt,
            FramesCorrupt: framesCorrupt,
            DecodedBlocks: root.GetInt("decoded_blocks"),
            TotalBlocks: root.GetInt("total_blocks"),
            DecodedFraction: root.GetDouble("decoded_fraction"),
            LossRatio: root.GetDouble("loss_ratio"),
            Complete: root.GetBool("complete"),
            MetaConfirmed: root.GetBool("meta_confirmed", defaultValue: false),
            SessionMismatchStreak: root.GetInt("session_mismatch_streak", defaultValue: 0));
    }
}

internal static class JsonElementExtensions
{
    public static int GetInt(this JsonElement e, string name, int defaultValue = 0) =>
        e.TryGetProperty(name, out JsonElement p) && p.ValueKind == JsonValueKind.Number
            ? p.GetInt32() : defaultValue;

    public static long GetLong(this JsonElement e, string name, long defaultValue = 0) =>
        e.TryGetProperty(name, out JsonElement p) && p.ValueKind == JsonValueKind.Number
            ? p.GetInt64() : defaultValue;

    public static double GetDouble(this JsonElement e, string name, double defaultValue = 0.0) =>
        e.TryGetProperty(name, out JsonElement p) && p.ValueKind == JsonValueKind.Number
            ? p.GetDouble() : defaultValue;

    public static bool GetBool(this JsonElement e, string name, bool defaultValue = false) =>
        e.TryGetProperty(name, out JsonElement p) && p.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? p.GetBoolean() : defaultValue;
}
