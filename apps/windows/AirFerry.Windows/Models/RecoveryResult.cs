using AirFerry.Windows.Bundle;

namespace AirFerry.Windows.Models;

/// <summary>
/// Outcome of recovering and staging a received transfer — the Windows
/// counterpart of Android's <c>recoverAndStage</c> return value. Exactly one of
/// <see cref="SingleFile"/> / <see cref="Bundle"/> is non-null: the sender
/// either emits a single-file transfer (never carries the ETBUNDL1 magic) or a
/// multi-file bundle.
/// </summary>
public sealed record RecoveryResult(
    string? SingleFilePath,
    ulong? SingleFileSize,
    ulong? ExpectedCrc32,
    bool Crc32Known,
    ulong? ReceivedCrc32,
    IReadOnlyList<BundleFile>? Bundle,
    string? BundleDir)
{
    public bool IsBundle => Bundle is not null && Bundle.Count > 0;
}
