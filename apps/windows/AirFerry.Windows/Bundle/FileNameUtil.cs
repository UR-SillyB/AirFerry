using System.IO;
using System.Text;

namespace AirFerry.Windows.Bundle;

/// <summary>
/// Filename helpers shared by the receive / detail / bundle views.
/// </summary>
/// <remarks>
/// <para>
/// Mirrors Android's <c>FileNameUtil.kt</c>: strip only characters that are
/// genuinely illegal across filesystems (slash, backslash, colon, asterisk,
/// question mark, double-quote, angle brackets, pipe, C0 control characters),
/// reduce to the final path component, drop leading dots. Spaces, full-width
/// punctuation and all Unicode letters (including CJK extension planes) are
/// kept intact.
/// </para>
/// <para>
/// <b>Windows extras</b> (beyond the Android version):
/// <list type="bullet">
/// <item>Reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) get a
/// trailing <c>_</c> so they're no longer treated as devices.</item>
/// <item>Trailing dots/spaces are stripped (Win32 drops them silently, which
/// would change the displayed name).</item>
/// <item>Truncation respects char surrogate pairs to avoid splitting a
/// 4-byte UTF-16 character.</item>
/// </list>
/// </para>
/// <para>
/// The recovered filename is attacker-controllable (decoded from a scanned
/// QR), so <see cref="Sanitize"/> also defends against path traversal.
/// Call sites that write into a directory should use <see cref="UniqueTarget"/>,
/// which additionally verifies the resolved path stays inside that directory.
/// </para>
/// </remarks>
public static class FileNameUtil
{
    private const int MaxComponentChars = 200;
    private const string FallbackName = "received_file";

    /// <summary>
    /// Strip characters that are illegal in filenames across common
    /// filesystems, reduce to the final path component, drop leading dots,
    /// and neutralize Windows reserved device names.
    /// </summary>
    /// <remarks>
    /// Never returns blank, <c>.</c>, or <c>..</c> (falls back to
    /// <c>received_file</c>). Truncates to 200 chars.
    /// </remarks>
    public static string Sanitize(string name)
    {
        // Reduce to the final path component first so an attacker-controlled
        // name can't smuggle directory separators / traversal through.
        string base_ = name;
        int slash = base_.LastIndexOfAny(['/', '\\']);
        if (slash >= 0)
        {
            base_ = base_[(slash + 1)..];
        }

        // Strip genuinely-illegal chars + C0 control chars, replacing with '_'
        // (matches Android's Regex.replace("[/\\:*?\"<>|\\p{Cntrl}]", "_")).
        var sb = new StringBuilder(base_.Length);
        foreach (char c in base_)
        {
            if (IsIllegalFileNameChar(c))
            {
                sb.Append('_');
                continue;
            }
            sb.Append(c);
        }
        string cleaned = sb.ToString().Trim();

        // Truncate without splitting a UTF-16 surrogate pair.
        if (cleaned.Length > MaxComponentChars)
        {
            int cut = MaxComponentChars;
            if (cut > 0 && char.IsLowSurrogate(cleaned[cut]))
            {
                cut--; // keep the high surrogate company.
            }
            cleaned = cleaned[..cut];
        }
        // Trim again after truncation (trailing spaces/dots can reappear).
        cleaned = cleaned.Trim().TrimStart('.');

        if (string.IsNullOrEmpty(cleaned) || cleaned is "." or "..")
        {
            return FallbackName;
        }

        // Windows reserved device names: CON, PRN, AUX, NUL, COM1..9, LPT1..9.
        // Append "_" so "CON" becomes "CON_" (no longer a device).
        return NeutralizeReservedName(cleaned);
    }

    /// <summary>
    /// Return a non-existing file in <paramref name="dir"/> named
    /// <paramref name="name"/> (after sanitizing), appending <c>(1)</c>,
    /// <c>(2)</c>, … before the extension on collisions so the original name
    /// is never silently overwritten.
    /// </summary>
    public static string UniqueTarget(string dir, string name)
    {
        string safe = Sanitize(name);
        string first = Path.Combine(dir, safe);
        if (!IsWithin(dir, first))
        {
            return Path.Combine(dir, FallbackName);
        }
        if (!File.Exists(first))
        {
            return first;
        }

        // Split into base + extension for "(N)" insertion.
        string fileName = Path.GetFileName(safe);
        int dot = fileName.LastIndexOf('.');
        string basePart, extPart;
        if (dot >= 1 && dot < fileName.Length - 1)
        {
            basePart = fileName[..dot];
            extPart = fileName[dot..];
        }
        else
        {
            basePart = fileName;
            extPart = string.Empty;
        }

        int i = 1;
        string candidate;
        do
        {
            candidate = Path.Combine(dir, $"{basePart}({i}){extPart}");
            i++;
        }
        while (File.Exists(candidate));
        return candidate;
    }

    private static bool IsIllegalFileNameChar(char c)
    {
        // The Win32 + cross-filesystem illegal set: / \ : * ? " < > | plus all
        // C0 control chars (0x00..0x1F) and DEL (0x7F).
        if (c < 0x20 || c == 0x7F)
        {
            return true;
        }
        return c is '/' or '\\' or ':' or '*' or '?' or '"' or '<' or '>' or '|';
    }

    private static string NeutralizeReservedName(string name)
    {
        // Strip any extension for the reserved-name check (CON.txt is still
        // treated as the CON device by Win32).
        string stem = name;
        int dot = name.IndexOf('.');
        if (dot >= 0)
        {
            stem = name[..dot];
        }
        if (stem.Length is >= 3 and <= 4 && IsReservedStem(stem))
        {
            return name + "_";
        }
        return name;
    }

    private static bool IsReservedStem(string stem)
    {
        int len = stem.Length;
        if (len < 3 || len > 4)
        {
            return false;
        }
        // Fixed 3-char names (CON/PRN/AUX/NUL).
        if (len == 3)
        {
            return stem.Equals("CON", StringComparison.OrdinalIgnoreCase)
                || stem.Equals("PRN", StringComparison.OrdinalIgnoreCase)
                || stem.Equals("AUX", StringComparison.OrdinalIgnoreCase)
                || stem.Equals("NUL", StringComparison.OrdinalIgnoreCase);
        }
        // COM1-9 / LPT1-9 (length 4: 3-letter prefix + one digit).
        if (len == 4)
        {
            bool isComOrLpt = stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase)
                || stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase);
            return isComOrLpt && char.IsDigit(stem[3]);
        }
        return false;
    }

    private static bool IsWithin(string dir, string path)
    {
        try
        {
            string dirCanonical = Path.GetFullPath(dir)
                .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string pathCanonical = Path.GetFullPath(path);
            return pathCanonical.StartsWith(dirCanonical, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Soft cap for the in-memory text (copy) UI — mirrors Android
    /// <c>TextLike.MAX_TEXT_UI_BYTES</c>. Larger files stay on the file screen.
    /// </summary>
    public const int MaxTextUiBytes = 2 * 1024 * 1024;

    /// <summary>
    /// Heuristic: recovered files that should open in the text (copy/share) UI.
    /// Extension-based; mirrors Android <c>TextLike.isTextLikeName</c>.
    /// </summary>
    public static bool IsTextLikeName(string name)
    {
        string baseName = name;
        int slash = baseName.LastIndexOfAny(['/', '\\']);
        if (slash >= 0)
        {
            baseName = baseName[(slash + 1)..];
        }
        int dot = baseName.LastIndexOf('.');
        if (dot <= 0 || dot >= baseName.Length - 1)
        {
            return false;
        }
        string ext = baseName[(dot + 1)..].ToLowerInvariant();
        return TextLikeExtensions.Contains(ext);
    }

    public static bool FitsTextUi(long size) => size >= 0 && size <= MaxTextUiBytes;

    /// <summary>
    /// Decode <paramref name="bytes"/> as UTF-8 only if the sequence is valid and
    /// within <see cref="MaxTextUiBytes"/>. Mirrors Android
    /// <c>TextLike.decodeUtf8Strict</c>.
    /// </summary>
    public static string? DecodeUtf8Strict(byte[] bytes)
    {
        if (bytes.Length > MaxTextUiBytes)
        {
            return null;
        }
        try
        {
            var enc = new System.Text.UTF8Encoding(
                encoderShouldEmitUTF8Identifier: false,
                throwOnInvalidBytes: true);
            return enc.GetString(bytes);
        }
        catch
        {
            return null;
        }
    }

    // Keep in sync with apps/scanner/.../scan/TextLike.kt
    private static readonly HashSet<string> TextLikeExtensions = new(StringComparer.Ordinal)
    {
        "txt", "text", "md", "markdown", "rst", "adoc", "asciidoc",
        "csv", "tsv", "log", "nfo", "srt", "vtt", "diff", "patch",
        "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf",
        "properties", "env", "plist",
        "html", "htm", "css", "svg",
        "js", "mjs", "cjs", "ts", "tsx", "jsx",
        "py", "rb", "go", "rs", "java", "kt", "kts", "swift",
        "c", "h", "cpp", "cc", "cxx", "hpp", "cs", "sql", "sh", "bash",
        "zsh", "bat", "cmd", "ps1", "r", "lua", "php",
    };
}
