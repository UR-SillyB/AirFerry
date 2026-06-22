using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;

namespace AirFerry.Windows.Views;

/// <summary>
/// Settings page — mirrors Android's <c>SettingsActivity</c>: a "default
/// redundancy" slider persisted to %AppData%\AirFerry\settings.json (the .NET
/// analogue of SharedPreferences), plus the version read from the assembly (the
/// single source of truth — the csproj <c>&lt;Version&gt;</c>).
/// </summary>
public partial class SettingsView : Page
{
    private const int DefaultRedundancy = 5;
    private static readonly string SettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "AirFerry", "settings.json");

    public SettingsView()
    {
        InitializeComponent();
        Loaded += (_, _) => Populate();
    }

    private void Populate()
    {
        int redundancy = LoadRedundancy();
        RedundancySlider.Value = redundancy;
        RedundancyText.Text = $"{redundancy}%";

        // Read version from the assembly (the csproj <Version>).
        Version? ver = Assembly.GetExecutingAssembly().GetName().Version;
        VersionText.Text = ver is not null ? $"版本 {ver.Major}.{ver.Minor}.{ver.Build}" : "版本 ?";
    }

    private void Redundancy_Changed(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        int value = (int)Math.Round(e.NewValue);
        RedundancyText.Text = $"{value}%";
        SaveRedundancy(value);
    }

    private static int LoadRedundancy()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                string json = File.ReadAllText(SettingsPath);
                // Minimal hand-rolled parse — avoids a System.Text.Json dep here.
                int idx = json.IndexOf("\"default_redundancy\"");
                if (idx >= 0)
                {
                    int colon = json.IndexOf(':', idx);
                    if (colon >= 0)
                    {
                        int start = colon + 1;
                        while (start < json.Length && (json[start] == ' ' || json[start] == '\t')) start++;
                        int end = start;
                        while (end < json.Length && char.IsDigit(json[end])) end++;
                        if (int.TryParse(json.AsSpan(start, end - start), out int v))
                        {
                            return Math.Clamp(v, 5, 50);
                        }
                    }
                }
            }
        }
        catch { /* fall through to default */ }
        return DefaultRedundancy;
    }

    private static void SaveRedundancy(int value)
    {
        try
        {
            string? dir = Path.GetDirectoryName(SettingsPath);
            if (dir is not null)
            {
                Directory.CreateDirectory(dir);
            }
            File.WriteAllText(SettingsPath, $"{{\"default_redundancy\":{value}}}");
        }
        catch { /* settings are best-effort; never block the UI */ }
    }

    private void Back_Click(object sender, RoutedEventArgs e) => NavigationService?.GoBack();
}
