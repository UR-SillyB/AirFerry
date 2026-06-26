using AirFerry.Windows.Bundle;

namespace AirFerry.Windows.Models;

/// <summary>
/// Outcome of recovering and staging a received transfer — the Windows
/// counterpart of Android's <c>recoverAndStage</c> return value. Exactly one of
/// <see cref="SingleFilePath"/> / <see cref="Bundle"/> / <see cref="Text"/> is
/// non-null: the sender emits either a single-file transfer, a multi-file
/// bundle (ETBUNDL1 magic), or a text message (ETTEXTv1 magic).
/// </summary>
public sealed record RecoveryResult(
    string? SingleFilePath,
    ulong? SingleFileSize,
    ulong? ExpectedCrc32,
    bool Crc32Known,
    ulong? ReceivedCrc32,
    IReadOnlyList<BundleFile>? Bundle,
    string? BundleDir,
    string? Text = null)
{
    public bool IsBundle => Bundle is not null && Bundle.Count > 0;
    public bool IsText => !string.IsNullOrEmpty(Text);
}
