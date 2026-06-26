using System.Text;

namespace AirFerry.Windows.Bundle;

/// <summary>
/// Text payload parser — mirrors the browser sender's <c>text.ts</c> byte-for-byte,
/// and the Android <c>TextParser.kt</c>.
/// </summary>
/// <remarks>
/// A text transfer is, at the payload layer, just a single-file object: the
/// sender wraps the user's text in an 8-byte magic prefix and feeds the bytes
/// through the same compress → RaptorQ → QR pipeline as a file. After recovery
/// + decompression, the receiver detects the magic and decodes the UTF-8 text.
/// <para>
/// This mirrors the existing bundle-magic pattern (<see cref="BundleParser"/>):
/// the text/file distinction lives in the payload byte layer, NOT in the
/// descriptor, so the descriptor / protocol layer stays unchanged and old
/// receivers stay compatible (an old receiver that doesn't know this magic
/// falls through to single-file handling and saves the bytes as a .txt).
/// </para>
/// <para>
/// Wire layout:
/// <code>
/// offset  size   field
/// 0       8      magic: ASCII "ETTEXTv1" (0x45 54 54 45 58 54 76 31)
/// 8       …      UTF-8 text bytes (no length prefix; delimited by the
///                transfer-level original_size / compressed_size)
/// </code>
/// </para>
/// </remarks>
public static class TextParser
{
    public static ReadOnlySpan<byte> Magic => "ETTEXTv1"u8;

    /// <summary>True if bytes starts with the 8-byte text magic.</summary>
    public static bool IsText(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 8)
        {
            return false;
        }
        return bytes[..8].SequenceEqual(Magic);
    }

    /// <summary>
    /// Decode the text payload: strip the 8-byte magic and UTF-8-decode the
    /// rest. Returns null if <paramref name="bytes"/> does not carry the magic
    /// or the tail is not valid UTF-8. The caller should treat null as "not a
    /// text payload / corrupt" and fall back to single-file handling.
    /// </summary>
    public static string? Parse(ReadOnlySpan<byte> bytes)
    {
        if (!IsText(bytes))
        {
            return null;
        }
        try
        {
            return Encoding.UTF8.GetString(bytes[8..]);
        }
        catch
        {
            return null;
        }
    }
}
