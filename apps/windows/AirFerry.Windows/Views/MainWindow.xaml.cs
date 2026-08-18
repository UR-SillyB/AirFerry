using AirFerry.Windows.Services;

namespace AirFerry.Windows.Views;

/// <summary>
/// The single host window — replaces the implicit <c>NavigationWindow</c> that
/// WPF generated from the old <c>StartupUri</c>-to-Page setup. All views remain
/// <see cref="System.Windows.Controls.Page"/> instances navigated inside the
/// embedded Frame, so every existing <c>NavigationService.Navigate / GoBack</c>
/// call keeps working unchanged. The appearance preference is applied here
/// (before the first render) so the first paint already uses the right skin.
/// </summary>
public partial class MainWindow : HandyControl.Controls.Window
{
    public MainWindow()
    {
        InitializeComponent();
        ThemeService.ApplyPreference(AppSettings.Theme, this);
    }
}
