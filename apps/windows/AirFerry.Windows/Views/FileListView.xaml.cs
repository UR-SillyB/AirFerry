using System.Collections.ObjectModel;
using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using AirFerry.Windows.Bundle;
using AirFerry.Windows.Models;
using AirFerry.Windows.Scan;
using AirFerry.Windows.Services;

namespace AirFerry.Windows.Views;

/// <summary>
/// Received-file history browser — mirrors Android's <c>FileListActivity</c>.
/// Lists logical entries from <see cref="ContentStore"/>. Opening is always
/// handled inside AirFerry; untrusted received files are never shell-executed.
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
        PathHint.Text = $"位置: {ContentStore.RootDir}";
        IReadOnlyList<ContentStore.Entry> entries;
        try
        {
            ContentStore.MigrateLegacyReceivedIfNeeded();
            entries = ContentStore.ListEntries();
        }
        catch (InvalidDataException ex)
        {
            ClearButton.IsEnabled = false;
            PathHint.Text = ex.Message;
            _ = UiMessages.ErrorAsync(ex.Message);
            return;
        }
        ClearButton.IsEnabled = entries.Count > 0;
        foreach (ContentStore.Entry item in entries.OrderByDescending(e => e.CreatedAt))
        {
            string path = ContentStore.BlobPath(item.Hash);
            _entries.Add(new FileEntry(
                item.Id,
                item.BundleTitle is null ? item.Name : $"{item.BundleTitle} / {item.Name}",
                item.Name,
                FormatSize((ulong)item.Size),
                DateTimeOffset.FromUnixTimeMilliseconds(item.CreatedAt)
                    .ToLocalTime().ToString("yyyy-MM-dd HH:mm"),
                path,
                item.Kind,
                item.CrcHex,
                item.CrcUnknown));
        }

        string tempDir = Path.Combine(Path.GetTempPath(), "AirFerry");
        var pending = Scan.Af2LedgerStore.ListPendingTransfers(tempDir);
        if (pending.Count > 0)
        {
            long totalPendingBytes = pending.Sum(p => p.DiskBytes);
            PendingCard.Visibility = Visibility.Visible;
            PendingTitle.Text = $"{pending.Count} 个未完成断点传输";
            PendingDesc.Text = $"已占用磁盘 {FormatSize((ulong)totalPendingBytes)} · 再次扫描原二维码即可接续传输";
        }
        else
        {
            PendingCard.Visibility = Visibility.Collapsed;
        }
    }

    private void ClearPending_Click(object sender, RoutedEventArgs e)
    {
        string tempDir = Path.Combine(Path.GetTempPath(), "AirFerry");
        Scan.Af2LedgerStore.DiscardAllPending(tempDir);
        Refresh();
    }

    private async void FileList_DoubleClick(object sender, RoutedEventArgs e)
    {
        if (FilesListView.SelectedItem is not FileEntry entry)
        {
            return;
        }
        if (!File.Exists(entry.FullPath))
        {
            await UiMessages.ErrorAsync("内容文件已丢失或损坏。");
            return;
        }
        try
        {
            long len = new FileInfo(entry.FullPath).Length;
            bool textCandidate = entry.Kind == "text" || FileNameUtil.IsTextLikeName(entry.Name);
            if (textCandidate && FileNameUtil.FitsTextUi(len))
            {
                byte[] bytes = File.ReadAllBytes(entry.FullPath);
                string? text = FileNameUtil.DecodeUtf8Strict(bytes);
                if (text is not null)
                {
                    var textResult = BuildResult(entry, (ulong)bytes.Length,
                        Crc32.Compute(bytes), text);
                    NavigationService?.Navigate(new ReceiveTextView(textResult, entry.Name));
                    return;
                }
                // Whole-stream CRC for a blob that can be GB-scale must not run
                // on the dispatcher thread — it froze the UI for the full read.
                ulong receivedCrc = await Task.Run(() =>
                {
                    using FileStream stream = File.OpenRead(entry.FullPath);
                    return Crc32.Compute(stream);
                });
                NavigationService?.Navigate(new ReceiveDetailView(
                    BuildResult(entry, (ulong)len, receivedCrc, null)));
                return;
            }
            ulong streamCrc = await Task.Run(() =>
            {
                using FileStream stream = File.OpenRead(entry.FullPath);
                return Crc32.Compute(stream);
            });
            NavigationService?.Navigate(new ReceiveDetailView(
                BuildResult(entry, (ulong)len, streamCrc, null)));
        }
        catch (Exception ex)
        {
            await UiMessages.ErrorAsync($"无法打开: {ex.Message}");
        }
    }

    private async void ClearAll_Click(object sender, RoutedEventArgs e)
    {
        if (!await UiMessages.ConfirmAsync(
                "确定清空所有已接收文件？此操作不可撤销。",
                danger: true))
        {
            return;
        }
        try
        {
            ContentStore.ClearAll();
            Refresh();
        }
        catch (Exception ex)
        {
            await UiMessages.ErrorAsync($"清空失败: {ex.Message}");
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

    private static RecoveryResult BuildResult(
        FileEntry entry, ulong size, ulong receivedCrc, string? text)
    {
        ulong expected = 0;
        bool parsed = !entry.CrcUnknown && ulong.TryParse(entry.CrcHex,
            NumberStyles.HexNumber, CultureInfo.InvariantCulture, out expected);
        return new RecoveryResult(
            SingleFilePath: entry.FullPath,
            SingleFileSize: size,
            ExpectedCrc32: parsed ? expected : null,
            Crc32Known: parsed,
            ReceivedCrc32: receivedCrc,
            Bundle: null,
            BundleDir: null,
            Text: text,
            DisplayName: entry.Name);
    }

    public sealed record FileEntry(
        string Id,
        string DisplayName,
        string Name,
        string SizeText,
        string ModifiedText,
        string FullPath,
        string Kind,
        string CrcHex,
        bool CrcUnknown);
}
