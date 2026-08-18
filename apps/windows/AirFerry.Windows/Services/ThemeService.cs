using System.Windows;
using Microsoft.Win32;

namespace AirFerry.Windows.Services;

/// <summary>
/// Applies the appearance preference from <see cref="AppSettings"/> ("light" /
/// "dark" / "system") to the whole app: swaps the HandyControl skin dictionary
/// Source (SkinDefault &lt;-&gt; SkinDark) and re-points the AirFerry
/// semantic-token dictionary. The brand accent is theme-constant and lives in
/// Themes/AirFerry.xaml, so it needs no re-application. In "system" mode a
/// <see cref="SystemEvents.UserPreferenceChanged"/> subscription follows OS
/// theme changes live. HandyControl's own <c>Theme.SyncWithSystem</c> is NOT
/// used — it could not swap our DesignTokens dictionary along with the skin.
/// </summary>
public static class ThemeService
{
    private const string SkinMarker = "HandyControl;component/Themes/Skin";
    private static readonly Uri LightSkin = new(
        "pack://application:,,,/HandyControl;component/Themes/SkinDefault.xaml");
    private static readonly Uri DarkSkin = new(
        "pack://application:,,,/HandyControl;component/Themes/SkinDark.xaml");

    private static string _preference = AppSettings.ThemeSystem;
    private static bool _isDarkEffective;
    private static bool _watchingSystem;

    /// <summary>
    /// Apply the persisted preference. Call once before the main window is
    /// shown (no visible light/dark flash), then again whenever the user
    /// changes the appearance setting.
    /// </summary>
    public static void ApplyPreference(string preference, Window? windowToWatch)
    {
        _preference = preference;
        ApplyEffectiveTheme();
        UpdateSystemWatcher();
    }

    /// <summary>Current effective theme after the last apply.</summary>
    public static bool IsDarkEffective => _isDarkEffective;

    private static void ApplyEffectiveTheme()
    {
        bool dark = _preference switch
        {
            AppSettings.ThemeLight => false,
            AppSettings.ThemeDark => true,
            // "system": decide from the registry ourselves. This reads
            // AppsUseLightTheme directly — the proven-correct source; matching
            // the OS .theme FILE name (the bug that made the old library boot
            // dark on light systems) is not involved.
            _ => !SystemPrefersLight(),
        };
        ApplyTheme(dark);
    }

    private static void ApplyTheme(bool dark)
    {
        _isDarkEffective = dark;
        ResourceDictionary? appResources = Application.Current?.Resources;
        if (appResources is null)
        {
            return;
        }
        foreach (ResourceDictionary dict in appResources.MergedDictionaries)
        {
            string? source = dict.Source?.OriginalString;
            if (source is null)
            {
                continue;
            }
            if (source.Contains(SkinMarker, StringComparison.OrdinalIgnoreCase))
            {
                Uri target = dark ? DarkSkin : LightSkin;
                if (!string.Equals(source, target.OriginalString, StringComparison.OrdinalIgnoreCase))
                {
                    dict.Source = target;
                }
            }
            else if (source.Contains("DesignTokens", StringComparison.Ordinal))
            {
                string name = dark ? "DesignTokens.Dark.xaml" : "DesignTokens.Light.xaml";
                if (!source.EndsWith(name, StringComparison.Ordinal))
                {
                    dict.Source = new Uri($"Themes/{name}", UriKind.Relative);
                }
            }
        }
    }

    private static void UpdateSystemWatcher()
    {
        bool want = _preference == AppSettings.ThemeSystem;
        if (want == _watchingSystem)
        {
            return;
        }
        if (want)
        {
            SystemEvents.UserPreferenceChanged += OnUserPreferenceChanged;
        }
        else
        {
            SystemEvents.UserPreferenceChanged -= OnUserPreferenceChanged;
        }
        _watchingSystem = want;
    }

    /// <summary>
    /// Any preference change re-triggers the (cheap, idempotent) registry
    /// check — Windows fires this event under several categories when the OS
    /// theme flips, so no category filter. Marshalled to the UI thread by
    /// <see cref="SystemEvents"/> because the subscription is made there.
    /// </summary>
    private static void OnUserPreferenceChanged(object sender, UserPreferenceChangedEventArgs e)
    {
        ApplyEffectiveTheme();
    }

    /// <summary>
    /// True when the user's apps-mode is light. Reads
    /// <c>HKCU\...\Personalize\AppsUseLightTheme</c> — the source of truth for
    /// "system" mode. High-contrast is left to the OS/HC defaults.
    /// </summary>
    private static bool SystemPrefersLight()
    {
        object? value = Registry.GetValue(
            @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "AppsUseLightTheme",
            defaultValue: 1);
        return value is not 0;
    }
}
