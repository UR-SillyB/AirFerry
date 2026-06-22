using System.Text.Json;
using AirFerry.Windows.Scan;
using Xunit;

namespace AirFerry.Windows.Tests;

/// <summary>
/// Verifies ProgressSnapshot parsing against the JSON emitted by
/// <c>cffi.rs::progress_json</c> (identical to <c>jni.rs::progress_json</c>).
/// Ensures the host parses every field the Rust side emits — including the
/// "framesDropped = duplicate + corrupt" convention shared with Kotlin.
/// </summary>
public class ProgressSnapshotTests
{
    // A representative JSON string straight from progress_json's format!.
    private const string SampleJson = """
        {"decoded_symbols":50,"total_symbols":100,"received_symbols":80,
        "frames_seen":120,"frames_duplicate":10,"frames_corrupt":5,
        "decoded_blocks":2,"total_blocks":4,"decoded_fraction":0.5000,
        "loss_ratio":0.1250,"complete":false,"meta_confirmed":true,
        "session_mismatch_streak":0}
        """;

    [Fact]
    public void Parse_ReadsAllFields()
    {
        var p = ProgressSnapshot.Parse(SampleJson);
        Assert.Equal(50, p.DecodedSymbols);
        Assert.Equal(100, p.TotalSymbols);
        Assert.Equal(80, p.ReceivedSymbols);
        Assert.Equal(120, p.FramesSeen);
        Assert.Equal(10 + 5, p.FramesDropped); // duplicate + corrupt union.
        Assert.Equal(5, p.FramesCorrupt);
        Assert.Equal(2, p.DecodedBlocks);
        Assert.Equal(4, p.TotalBlocks);
        Assert.Equal(0.5, p.DecodedFraction, precision: 4);
        Assert.Equal(0.125, p.LossRatio, precision: 4);
        Assert.False(p.Complete);
        Assert.True(p.MetaConfirmed);
        Assert.Equal(0, p.SessionMismatchStreak);
    }

    [Fact]
    public void Parse_CompleteFlag_Preserved()
    {
        string json = SampleJson.Replace("\"complete\":false", "\"complete\":true");
        Assert.True(ProgressSnapshot.Parse(json).Complete);
    }

    [Fact]
    public void Parse_MissingOptionalFields_DefaultsGracefully()
    {
        // meta_confirmed and session_mismatch_streak use optBool/optInt in the
        // Kotlin side; the C# parser must tolerate their absence too.
        const string minimal = """
            {"decoded_symbols":0,"total_symbols":0,"received_symbols":0,
            "frames_seen":0,"frames_duplicate":0,"frames_corrupt":0,
            "decoded_blocks":0,"total_blocks":0,"decoded_fraction":0.0,
            "loss_ratio":0.0,"complete":false}
            """;
        var p = ProgressSnapshot.Parse(minimal);
        Assert.False(p.MetaConfirmed);
        Assert.Equal(0, p.SessionMismatchStreak);
    }
}
