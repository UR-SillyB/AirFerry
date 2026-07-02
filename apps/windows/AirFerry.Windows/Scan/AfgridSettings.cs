using AirFerry.Windows.Native;

namespace AirFerry.Windows.Scan;

public static class AfgridSettings
{
    private const int DefaultSymbolSize = 5600;
    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "AirFerry", "settings.json");

    public static int LoadSymbolSize()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return DefaultSymbolSize;
            string json = File.ReadAllText(SettingsPath);
            int idx = json.IndexOf("\"afgrid_symbol_size\"");
            if (idx < 0) return DefaultSymbolSize;
            int colon = json.IndexOf(':', idx);
            int start = colon + 1;
            while (start < json.Length && (json[start] == ' ' || json[start] == '\t')) start++;
            int end = start;
            while (end < json.Length && char.IsDigit(json[end])) end++;
            if (int.TryParse(json.AsSpan(start, end - start), out int v))
                return Math.Clamp(v, 256, 16384);
        }
        catch { }
        return DefaultSymbolSize;
    }

    public static int ExpectedSide() =>
        (int)NativeBridge.AfgridSideForSymbolSize((uint)LoadSymbolSize());

    public static void SaveSymbolSize(int value)
    {
        value = Math.Clamp(value, 256, 16384);
        try
        {
            string? dir = Path.GetDirectoryName(SettingsPath);
            if (dir is not null) Directory.CreateDirectory(dir);
            int redundancy = LoadRedundancy();
            File.WriteAllText(SettingsPath, $"{{\"default_redundancy\":{redundancy},\"afgrid_symbol_size\":{value}}}");
        }
        catch { }
    }

    internal static int LoadRedundancy()
    {
        try
        {
            if (!File.Exists(SettingsPath)) return 5;
            string json = File.ReadAllText(SettingsPath);
            int idx = json.IndexOf("\"default_redundancy\"");
            if (idx < 0) return 5;
            int colon = json.IndexOf(':', idx);
            int start = colon + 1;
            while (start < json.Length && (json[start] == ' ' || json[start] == '\t')) start++;
            int end = start;
            while (end < json.Length && char.IsDigit(json[end])) end++;
            return int.TryParse(json.AsSpan(start, end - start), out int v) ? Math.Clamp(v, 5, 50) : 5;
        }
        catch { return 5; }
    }
}
