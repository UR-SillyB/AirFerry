using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using AirFerry.Windows.Bundle;
using AirFerry.Windows.Models;
using AirFerry.Windows.ViewModels;
using Microsoft.Win32;

namespace AirFerry.Windows.Views;

/// <summary>
/// Multi-file bundle receive page — mirrors Android's
/// <c>ReceiveBundleActivity</c>: lists each unpacked file with name + size,
/// offers "save all" / "share all" / "rescan". Double-click (or Enter) on a
/// .txt entry opens <see cref="ReceiveTextView"/> so mixed-batch text can be
/// copied (sender materialises "添加文字" as named .txt inside ETBUNDL1).
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
        FileListView.MouseDoubleClick += FileListView_MouseDoubleClick;
        FileListView.KeyDown += FileListView_KeyDown;
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
            bool looksText = FileNameUtil.IsTextLikeName(f.Name);
            _rows.Add(new BundleFileRow(
                f.Name,
                looksText
                    ? $"{FormatSize((ulong)f.Data.Length)} · 双击可复制"
                    : FormatSize((ulong)f.Data.Length),
                looksText));
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

    private void FileListView_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (FileListView.SelectedItem is BundleFileRow row)
        {
            OpenTextIfPossible(row.Name);
        }
    }

    private void FileListView_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && FileListView.SelectedItem is BundleFileRow row)
        {
            OpenTextIfPossible(row.Name);
            e.Handled = true;
        }
    }

    private void OpenTextIfPossible(string name)
    {
        if (!FileNameUtil.IsTextLikeName(name) || _result.Bundle is null)
        {
            return;
        }
        BundleFile? match = null;
        foreach (BundleFile f in _result.Bundle)
        {
            if (f.Name == name)
            {
                match = f;
                break;
            }
        }
        if (match is null)
        {
            return;
        }
        if (!FileNameUtil.FitsTextUi(match.Data.LongLength))
        {
            MessageBox.Show("文件过大，请用「全部保存」后用其他应用打开。", "AirFerry",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        string? text = FileNameUtil.DecodeUtf8Strict(match.Data);
        if (text is null)
        {
            MessageBox.Show("该文件不是有效的 UTF-8 文本，无法复制预览。", "AirFerry",
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        // Per-entry CRC is not tracked for bundle members.
        var textResult = new RecoveryResult(
            SingleFilePath: null,
            SingleFileSize: null,
            ExpectedCrc32: null,
            Crc32Known: false,
            ReceivedCrc32: null,
            Bundle: null,
            BundleDir: null,
            Text: text);
        NavigationService?.Navigate(new ReceiveTextView(textResult, suggestedFileName: name));
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
    public sealed record BundleFileRow(string Name, string SizeText, bool LooksText = false);
}
