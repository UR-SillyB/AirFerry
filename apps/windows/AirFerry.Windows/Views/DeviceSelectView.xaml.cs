using System.Windows;
using System.Windows.Controls;
using AirFerry.Windows.Models;
using AirFerry.Windows.Scan;

namespace AirFerry.Windows.Views;

/// <summary>
/// The landing page — device selection (webcams + capture cards). Mirrors the
/// user's explicit ask ("添加设备选择功能，可以选择摄像头或采集卡"): enumerate every
/// DirectShow video-input device, let the user pick one, then navigate to the
/// scan view bound to that device index.
/// </summary>
public partial class DeviceSelectView : Page
{
    private IReadOnlyList<DeviceInfo> _devices = Array.Empty<DeviceInfo>();

    public DeviceSelectView()
    {
        InitializeComponent();
        Loaded += (_, _) => RefreshDevices();
    }

    private void RefreshDevices()
    {
        DeviceList.Items.Clear();
        _devices = DeviceEnumerator.Enumerate();
        if (_devices.Count == 0)
        {
            DeviceList.Items.Add("未检测到视频设备");
            SelectedInfo.Text = "请连接摄像头或采集卡后点击刷新";
            StartButton.IsEnabled = false;
            return;
        }
        foreach (DeviceInfo d in _devices)
        {
            DeviceList.Items.Add(d);
        }
        SelectedInfo.Text = $"共 {_devices.Count} 个设备";
        // Pre-select the first device for quick start.
        DeviceList.SelectedIndex = 0;
    }

    private void Refresh_Click(object sender, RoutedEventArgs e) => RefreshDevices();

    private void DeviceList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (DeviceList.SelectedIndex < 0 || DeviceList.SelectedIndex >= _devices.Count)
        {
            StartButton.IsEnabled = false;
            return;
        }
        DeviceInfo d = _devices[DeviceList.SelectedIndex];
        StartButton.IsEnabled = true;
        SelectedInfo.Text = d.IsCaptureCard
            ? $"已选择采集卡: {d.FriendlyName}"
            : $"已选择摄像头: {d.FriendlyName}";
    }

    private void StartScan_Click(object sender, RoutedEventArgs e)
    {
        if (DeviceList.SelectedIndex < 0 || DeviceList.SelectedIndex >= _devices.Count)
        {
            return;
        }
        DeviceInfo selected = _devices[DeviceList.SelectedIndex];
        NavigationService?.Navigate(new ScanView(selected.Index));
    }

    private void Settings_Click(object sender, RoutedEventArgs e)
    {
        NavigationService?.Navigate(new SettingsView());
    }
}
