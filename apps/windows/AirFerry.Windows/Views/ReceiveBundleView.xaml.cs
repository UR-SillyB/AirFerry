using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using AirFerry.Windows.Bundle;
using AirFerry.Windows.Models;
using AirFerry.Windows.ViewModels;
using Microsoft.Win32;

namespace AirFerry.Windows.Views;

/// <summary>
/// Multi-file bundle receive page — mirrors Android's
/// <c>ReceiveBundleActivity</c>: lists each unpacked file with name + size,
/// offers "save all" (sequential SaveFileDialogs) / "share all" / "rescan".
/// </summary>
public partial class ReceiveBundleView : Page
{
    private readonly RecoveryResult _result;
    private readonly ObservableCollection<BundleFileRow> _rows = [];

    public ReceiveBundleView(RecoveryResult result)
    {
        InitializeComponent();
        _result = result;
        FileListView.ItemsSource = _rows;
        Loaded += (_, _) => Populate();
    }

    private void Populate()
    {
        _rows.Clear();
        if (_result.Bundle is null)
        {
            return;
        }
        foreach (BundleFile f in _result.Bundle)
        {
            _rows.Add(new BundleFileRow(f.Name, FormatSize((ulong)f.Data.Length)));
        }
        if (!_result.Crc32Known)
        {
            CrcStatusText.Text = $"共 {_result.Bundle.Count} 个文件 · 未提供校验码";
        }
        else if (_result.ExpectedCrc32 == _result.ReceivedCrc32)
        {
            CrcStatusText.Text = $"共 {_result.Bundle.Count} 个文件 · ✓ 校验通过";
            CrcStatusText.Foreground = new SolidColorBrush(Color.FromRgb(0x22, 0xC5, 0x5E));
        }
        else
        {
            CrcStatusText.Text = $"共 {_result.Bundle.Count} 个文件 · ✗ 校验失败";
            CrcStatusText.Foreground = new SolidColorBrush(Color.FromRgb(0xEF, 0x44, 0x44));
        }
    }

    private async void SaveAll_Click(object sender, RoutedEventArgs e)
    {
        if (_result.Bundle is null)
        {
            return;
        }
        // Prompt once for a target directory.
        var dlg = new OpenFolderDialog
        {
            Title = "选择保存目录",
        };
        if (dlg.ShowDialog() != true)
        {
            return;
        }
        string dir = dlg.FolderName;
        Directory.CreateDirectory(dir);
        int saved = 0;
        foreach (BundleFile f in _result.Bundle)
        {
            string target = FileNameUtil.UniqueTarget(dir, f.Name);
            await Task.Run(() => File.WriteAllBytes(target, f.Data));
            saved++;
        }
        // Also archive into received/ as a grouped bundle.
        ScanViewModel.ArchiveBundle(_result.Bundle);
        MessageBox.Show($"已保存 {saved} 个文件到:\n{dir}", "AirFerry",
            MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void ShareAll_Click(object sender, RoutedEventArgs e)
    {
        // Archive the bundle into a fresh subdir then open Explorer there.
        if (_result.Bundle is null)
        {
            return;
        }
        string dir = ScanViewModel.ArchiveBundle(_result.Bundle);
        Process.Start("explorer.exe", dir);
    }

    private void Rescan_Click(object sender, RoutedEventArgs e) => NavigationService?.GoBack();

    private static string FormatSize(ulong bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:F1} KB",
        < 1024UL * 1024 * 1024 => $"{bytes / (1024.0 * 1024):F1} MB",
        _ => $"{bytes / (1024.0 * 1024 * 1024):F2} GB",
    };

    /// <summary>Row model for the file list GridView.</summary>
    public sealed record BundleFileRow(string Name, string SizeText);
}
