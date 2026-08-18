using System.IO;

namespace AirFerry.Windows.Services;

/// <summary>
/// Single owner of <c>%AppData%\AirFerry\settings.json</c> — the .NET analogue
/// of Android's SharedPreferences. The file stays a tiny hand-rolled JSON object
/// (no System.Text.Json dependency, cross-end format parity). It currently holds
/// two keys: <c>default_redundancy</c> (int, 5–50) and <c>theme</c>
/// ("light" | "dark" | "system"). Values are cached in memory; every mutation
/// rewrites the whole file so one key never drops the other.
/// </summary>
public static class AppSettings
{
    public const int DefaultRedundancy = 5;
    public const string ThemeSystem = "system";
    public const string ThemeLight = "light";
    public const string ThemeDark = "dark";

    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "AirFerry", "settings.json");

    private static bool _loaded;
    private static int _redundancy = DefaultRedundancy;
    private static string _theme = ThemeSystem;
    private static string _continuousDir = "";
    private static bool _continuousOn;

    public static int Redundancy
    {
        get { EnsureLoaded(); return _redundancy; }
    }

    public static string Theme
    {
        get { EnsureLoaded(); return _theme; }
    }

    /// <summary>Last folder used by continuous receive ("" = never set).</summary>
    public static string ContinuousSaveDir
    {
        get { EnsureLoaded(); return _continuousDir; }
    }

    /// <summary>Whether continuous receive was enabled on the device-select page.</summary>
    public static bool ContinuousOn
    {
        get { EnsureLoaded(); return _continuousOn; }
    }

    public static void SetRedundancy(int value)
    {
        EnsureLoaded();
        _redundancy = Math.Clamp(value, 5, 50);
        Save();
    }

    public static void SetTheme(string? value)
    {
        EnsureLoaded();
        _theme = NormalizeTheme(value);
        Save();
    }

    public static void SetContinuousSaveDir(string? value)
    {
        EnsureLoaded();
        _continuousDir = value?.Trim() ?? "";
        Save();
    }

    public static void SetContinuousOn(bool value)
    {
        EnsureLoaded();
        _continuousOn = value;
        Save();
    }

    /// <summary>
    /// Escape a value for the hand-rolled JSON string literal. Windows paths
    /// contain backslashes and may contain quotes — both must be escaped or
    /// the settings file becomes unparseable garbage.
    /// </summary>
    public static string EscapeJsonString(string value) =>
        value.Replace("\\", "\\\\").Replace("\"", "\\\"");

    /// <summary>Inverse of <see cref="EscapeJsonString"/>.</summary>
    public static string UnescapeJsonString(string value)
    {
        if (!value.Contains('\\'))
        {
            return value;
        }
        var sb = new System.Text.StringBuilder(value.Length);
        for (int i = 0; i < value.Length; i++)
        {
            if (value[i] == '\\' && i + 1 < value.Length)
            {
                sb.Append(value[i + 1]);
                i++;
            }
            else
            {
                sb.Append(value[i]);
            }
        }
        return sb.ToString();
    }

    private static string NormalizeTheme(string? value) =>
        value is ThemeLight or ThemeDark ? value : ThemeSystem;

    private static void EnsureLoaded()
    {
        if (_loaded)
        {
            return;
        }
        _loaded = true;
        try
        {
            if (!File.Exists(SettingsPath))
            {
                return;
            }
            string json = File.ReadAllText(SettingsPath);
            // Minimal hand-rolled parse — deliberately no System.Text.Json here.
            _redundancy = Math.Clamp(ParseInt(json, "default_redundancy", DefaultRedundancy), 5, 50);
            _theme = NormalizeTheme(ParseString(json, "theme"));
            _continuousDir = ParseString(json, "continuous_dir") ?? "";
            _continuousOn = ParseBool(json, "continuous_on", false);
        }
        catch { /* fall through to defaults */ }
    }

    private static bool ParseBool(string json, string key, bool fallback)
    {
        int idx = json.IndexOf($"\"{key}\"", StringComparison.Ordinal);
        if (idx < 0)
        {
            return fallback;
        }
        int colon = json.IndexOf(':', idx);
        if (colon < 0)
        {
            return fallback;
        }
        int start = colon + 1;
        while (start < json.Length && (json[start] == ' ' || json[start] == '\t')) start++;
        if (start + 4 <= json.Length && json.AsSpan(start, 4).SequenceEqual("true"))
        {
            return true;
        }
        if (start + 5 <= json.Length && json.AsSpan(start, 5).SequenceEqual("false"))
        {
            return false;
        }
        return fallback;
    }

    private static int ParseInt(string json, string key, int fallback)
    {
        int idx = json.IndexOf($"\"{key}\"", StringComparison.Ordinal);
        if (idx < 0)
        {
            return fallback;
        }
        int colon = json.IndexOf(':', idx);
        if (colon < 0)
        {
            return fallback;
        }
        int start = colon + 1;
        while (start < json.Length && (json[start] == ' ' || json[start] == '\t')) start++;
        int end = start;
        while (end < json.Length && char.IsDigit(json[end])) end++;
        return int.TryParse(json.AsSpan(start, end - start), out int v) ? v : fallback;
    }

    private static string? ParseString(string json, string key)
    {
        int idx = json.IndexOf($"\"{key}\"", StringComparison.Ordinal);
        if (idx < 0)
        {
            return null;
        }
        int colon = json.IndexOf(':', idx);
        if (colon < 0)
        {
            return null;
        }
        int start = colon + 1;
        while (start < json.Length && (json[start] == ' ' || json[start] == '\t')) start++;
        if (start >= json.Length || json[start] != '"')
        {
            return null;
        }
        // Scan to the closing quote, honouring \" and \\ escapes.
        var sb = new System.Text.StringBuilder();
        int i = start + 1;
        while (i < json.Length)
        {
            char c = json[i];
            if (c == '\\' && i + 1 < json.Length)
            {
                sb.Append(json[i + 1]);
                i += 2;
                continue;
            }
            if (c == '"')
            {
                return sb.ToString();
            }
            sb.Append(c);
            i++;
        }
        return null;
    }

    private static void Save()
    {
        try
        {
            string? dir = Path.GetDirectoryName(SettingsPath);
            if (dir is not null)
            {
                Directory.CreateDirectory(dir);
            }
            File.WriteAllText(SettingsPath,
                $"{{\"default_redundancy\":{_redundancy},\"theme\":\"{_theme}\"," +
                $"\"continuous_dir\":\"{EscapeJsonString(_continuousDir)}\"," +
                $"\"continuous_on\":{(_continuousOn ? "true" : "false")}}}");
        }
        catch { /* settings are best-effort; never block the UI */ }
    }
}
