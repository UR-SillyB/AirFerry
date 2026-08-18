using System.Windows;
using System.Windows.Controls;
using AirFerry.Windows.Models;
using AirFerry.Windows.Scan;
using AirFerry.Windows.Services;

namespace AirFerry.Windows.Views;

/// <summary>
/// The landing page — mutually-exclusive scan-source selection. DirectShow
/// cameras/capture cards and the screen picker are peers in one list; the only
/// start button dispatches the selected source, so screen capture cannot be
/// triggered accidentally alongside a hardware source.
/// </summary>
public partial class DeviceSelectView : Page
{
    private IReadOnlyList<ScanSourceOption> _sources = Array.Empty<ScanSourceOption>();
    private string? _continuousDir;
    private bool _suppressToggleEvents;

    public DeviceSelectView()
    {
        InitializeComponent();
        _continuousDir = AppSettings.ContinuousSaveDir;
        _suppressToggleEvents = true;
        ContinuousToggle.IsChecked = AppSettings.ContinuousOn;
        _suppressToggleEvents = false;
        UpdateContinuousUi();
        Loaded += (_, _) => RefreshDevices();
    }

    private void ContinuousToggle_Checked(object sender, RoutedEventArgs e)
    {
        if (_suppressToggleEvents)
        {
            return;
        }
        if (string.IsNullOrEmpty(_continuousDir))
        {
            string? dir = PickContinuousFolder();
            if (dir is null)
            {
                // Cancelled the folder picker — revert the toggle without
                // re-entering this handler.
                _suppressToggleEvents = true;
                ContinuousToggle.IsChecked = false;
                _suppressToggleEvents = false;
                return;
            }
            _continuousDir = dir;
            AppSettings.SetContinuousSaveDir(dir);
        }
        AppSettings.SetContinuousOn(true);
        UpdateContinuousUi();
    }

    private void ContinuousToggle_Unchecked(object sender, RoutedEventArgs e)
    {
        if (_suppressToggleEvents)
        {
            return;
        }
        AppSettings.SetContinuousOn(false);
        UpdateContinuousUi();
    }

    private void ContinuousPick_Click(object sender, RoutedEventArgs e)
    {
        string? dir = PickContinuousFolder();
        if (dir is null)
        {
            return;
        }
        _continuousDir = dir;
        AppSettings.SetContinuousSaveDir(dir);
        UpdateContinuousUi();
    }

    private string? PickContinuousFolder()
    {
        var dlg = new Microsoft.Win32.OpenFolderDialog
        {
            Title = "选择持续接收的保存文件夹",
        };
        if (!string.IsNullOrEmpty(_continuousDir) && System.IO.Directory.Exists(_continuousDir))
        {
            dlg.InitialDirectory = _continuousDir;
        }
        return dlg.ShowDialog() == true ? dlg.FolderName : null;
    }

    private void UpdateContinuousUi()
    {
        bool on = ContinuousToggle.IsChecked == true;
        ContinuousDirText.Text = on && !string.IsNullOrEmpty(_continuousDir)
            ? $"保存至 {_continuousDir}"
            : string.Empty;
        ContinuousDirText.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        ContinuousPickButton.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
    }

    private void RefreshDevices()
    {
        IReadOnlyList<DeviceInfo> devices = DeviceEnumerator.Enumerate();
        _sources = ScanSourceOption.Build(devices);
        DeviceList.ItemsSource = _sources;
        EmptyStateBar.Visibility = devices.Count == 0
            ? Visibility.Visible
            : Visibility.Collapsed;
        SelectedInfo.Text = devices.Count == 0
            ? "屏幕捕获可用"
            : $"{devices.Count} 个视频设备 + 屏幕捕获";
        // Keep quick start for hardware; when none exists, screen capture is
        // the sole source and is selected explicitly in the same list.
        DeviceList.SelectedIndex = 0;
    }

    private void Refresh_Click(object sender, RoutedEventArgs e) => RefreshDevices();

    private void DeviceList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (DeviceList.SelectedItem is not ScanSourceOption source)
        {
            StartButton.IsEnabled = false;
            return;
        }
        StartButton.IsEnabled = true;
        SelectedInfo.Text = $"已选择：{source.FriendlyName}";
        StartButton.Content = source.IsScreenCapture ? "选择屏幕并开始扫码" : "开始扫码";
    }

    private async void StartScan_Click(object sender, RoutedEventArgs e)
    {
        if (DeviceList.SelectedItem is not ScanSourceOption selected)
        {
            return;
        }
        StartButton.IsEnabled = false;
        DeviceList.IsEnabled = false;
        try
        {
            bool continuous = ContinuousToggle.IsChecked == true;
            if (continuous && string.IsNullOrEmpty(_continuousDir))
            {
                // Checked but no folder picked yet (e.g. first ever run) —
                // prompt now; cancelling aborts the start.
                string? dir = PickContinuousFolder();
                if (dir is null)
                {
                    return;
                }
                _continuousDir = dir;
                AppSettings.SetContinuousSaveDir(dir);
                UpdateContinuousUi();
            }
            ScanSource? source = selected.IsScreenCapture
                ? await RegionPicker.PickAsync()
                : selected.CreateImmediateSource();
            if (source is null)
            {
                return;
            }
            NavigationService?.Navigate(new ScanView(
                source, continuous, _continuousDir));
        }
        catch (Exception ex)
        {
            await UiMessages.ErrorAsync($"扫描来源启动失败：{ex.Message}", "开始扫码");
        }
        finally
        {
            DeviceList.IsEnabled = true;
            StartButton.IsEnabled = DeviceList.SelectedItem is ScanSourceOption;
        }
    }

    private void Settings_Click(object sender, RoutedEventArgs e)
    {
        NavigationService?.Navigate(new SettingsView());
    }

    /// <summary>History/received files — reachable from the landing page, not
    /// only through the scan page.</summary>
    private void Files_Click(object sender, RoutedEventArgs e)
    {
        NavigationService?.Navigate(new FileListView());
    }
}
