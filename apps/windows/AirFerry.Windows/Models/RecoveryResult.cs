using AirFerry.Windows.Bundle;

namespace AirFerry.Windows.Models;

/// <summary>
/// Outcome of recovering and staging a received transfer — the Windows
/// counterpart of Android's <c>recoverAndStage</c> return value. Exactly one of
/// <see cref="SingleFilePath"/> / <see cref="Bundle"/> / <see cref="Text"/> is
/// non-null, classified from the AF2 Manifest entry kinds (FILE / UTF8_TEXT /
/// DIRECTORY): the sender emits either a single-file transfer, a multi-entry
/// manifest, or a lone text (UTF8_TEXT) entry.
/// </summary>
/// <param name="DisplayName">
/// Original filename from the manifest snapshot (or staged store name). Used by
/// the text receive page for save-as; optional for pure in-memory UTF8_TEXT
/// results that never wrote a path.
/// </param>
public sealed record RecoveryResult(
    string? SingleFilePath,
    ulong? SingleFileSize,
    ulong? ExpectedCrc32,
    bool Crc32Known,
    ulong? ReceivedCrc32,
    IReadOnlyList<BundleFile>? Bundle,
    string? BundleDir,
    string? Text = null,
    string? DisplayName = null)
{
    public bool IsBundle => Bundle is not null && Bundle.Count > 0;
    public bool IsText => Text is not null;
}
