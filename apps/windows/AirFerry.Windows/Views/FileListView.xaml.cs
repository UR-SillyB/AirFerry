using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using AirFerry.Windows.Bundle;
using AirFerry.Windows.Models;
using AirFerry.Windows.ViewModels;

namespace AirFerry.Windows.Views;

/// <summary>
/// Received-file history browser — mirrors Android's <c>FileListActivity</c>.
/// Lists files (and bundle subdirs) under <see cref="ScanViewModel.ReceivedDir"/>,
/// double-click to open (text-like → copy UI, else shell), "clear all" to wipe.
/// </summary>
public partial class FileListView : Page
{
    private readonly ObservableCollection<FileEntry> _entries = [];

    public FileListView()
    {
        InitializeComponent();
        FilesListView.ItemsSource = _entries;
        Loaded += (_, _) => Refresh();
    }

    private void Refresh()
    {
        _entries.Clear();
        string dir = ScanViewModel.ReceivedDir;
        PathHint.Text = $"位置: {dir}";
        if (!Directory.Exists(dir))
        {
            ClearButton.IsEnabled = false;
            return;
        }
        ClearButton.IsEnabled = true;

        var infos = new List<FileEntry>();
        // Directories (bundle subdirs) first, then files; both by modified desc.
        foreach (string d in Directory.EnumerateDirectories(dir))
        {
            var info = new DirectoryInfo(d);
            infos.Add(new FileEntry(
                info.Name + "/",
                info.Name,
                "—",
                info.LastWriteTime.ToString("yyyy-MM-dd HH:mm"),
                d,
                IsDirectory: true));
        }
        foreach (string f in Directory.EnumerateFiles(dir))
        {
            // Skip the .meta sidecars (mirror Android which filters them).
            if (f.EndsWith(".meta", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            var info = new FileInfo(f);
            infos.Add(new FileEntry(
                info.Name,
                info.Name,
                FormatSize((ulong)info.Length),
                info.LastWriteTime.ToString("yyyy-MM-dd HH:mm"),
                f,
                IsDirectory: false));
        }
        foreach (FileEntry entry in infos.OrderByDescending(e => e.ModifiedText))
        {
            _entries.Add(entry);
        }
    }

    private void FileList_DoubleClick(object sender, RoutedEventArgs e)
    {
        if (FilesListView.SelectedItem is not FileEntry entry)
        {
            return;
        }
        if (!entry.IsDirectory && FileNameUtil.IsTextLikeName(entry.Name))
        {
            try
            {
                long len = new FileInfo(entry.FullPath).Length;
                if (FileNameUtil.FitsTextUi(len))
                {
                    byte[] bytes = File.ReadAllBytes(entry.FullPath);
                    string? text = FileNameUtil.DecodeUtf8Strict(bytes);
                    if (text is not null)
                    {
                        var result = new RecoveryResult(
                            SingleFilePath: entry.FullPath,
                            SingleFileSize: (ulong)bytes.Length,
                            ExpectedCrc32: null,
                            Crc32Known: false,
                            ReceivedCrc32: null,
                            Bundle: null,
                            BundleDir: null,
                            Text: text);
                        NavigationService?.Navigate(new ReceiveTextView(result, entry.Name));
                        return;
                    }
                }
                // Oversize or invalid UTF-8 → fall through to shell open.
            }
            catch (Exception ex)
            {
                MessageBox.Show($"无法作为文字打开: {ex.Message}", "AirFerry",
                    MessageBoxButton.OK, MessageBoxImage.Error);
                // fall through to shell open
            }
        }
        // Open with the shell handler (file → default app, dir → Explorer).
        Process.Start(new ProcessStartInfo(entry.FullPath)
        {
            UseShellExecute = true,
        });
    }

    private void ClearAll_Click(object sender, RoutedEventArgs e)
    {
        if (MessageBox.Show("确定清空所有已接收文件？此操作不可撤销。", "AirFerry",
            MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK)
        {
            return;
        }
        try
        {
            string dir = ScanViewModel.ReceivedDir;
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, recursive: true);
            }
            Refresh();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"清空失败: {ex.Message}", "AirFerry", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void Back_Click(object sender, RoutedEventArgs e) => NavigationService?.GoBack();

    private static string FormatSize(ulong bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:F1} KB",
        < 1024UL * 1024 * 1024 => $"{bytes / (1024.0 * 1024):F1} MB",
        _ => $"{bytes / (1024.0 * 1024 * 1024):F2} GB",
    };

    public sealed record FileEntry(
        string DisplayName,
        string Name,
        string SizeText,
        string ModifiedText,
        string FullPath,
        bool IsDirectory);
}
