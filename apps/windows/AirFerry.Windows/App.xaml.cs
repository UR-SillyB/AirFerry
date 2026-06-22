using System.Windows;

namespace AirFerry.Windows;

/// <summary>
/// Code-behind for App.xaml. The startup URI is <c>DeviceSelectView</c> (the
/// device-selection page — the user's first interaction), mirroring how Android's
/// launcher Activity is <c>ScanActivity</c>. Navigation between views uses WPF's
/// <c>NavigationService</c>, the WPF analogue of Android's <c>Intent</c>-based
/// Activity switching.
/// </summary>
public partial class App : Application
{
}
