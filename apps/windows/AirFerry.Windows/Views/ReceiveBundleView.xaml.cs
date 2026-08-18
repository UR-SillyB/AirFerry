using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using AirFerry.Windows.Bundle;
using AirFerry.Windows.Models;
using AirFerry.Windows.Services;
using AirFerry.Windows.ViewModels;
using AirFerry.Windows.Controls;
using Microsoft.Win32;

namespace AirFerry.Windows.Views;

/// <summary>
/// Multi-file bundle receive page — mirrors Android's
/// <c>ReceiveBundleActivity</c>: lists each unpacked file with name + size,
/// offers "save all" / "open folder" / "rescan". Double-click (or Enter) on a
/// .txt entry opens <see cref="ReceiveTextView"/> so mixed-batch text can be
/// copied (sender materialises "添加文字" as a named .txt FILE entry in the
/// AF2 Manifest).
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
                    ? $"{FormatSize((ulong)f.Size)} · 双击可复制"
                    : FormatSize((ulong)f.Size),
                looksText));
        }
        if (!_result.Crc32Known)
        {
            CrcInfoBar.Severity = InfoBarSeverity.Informational;
            CrcInfoBar.Title = $"共 {_result.Bundle.Count} 个文件";
            CrcInfoBar.Message = "未提供校验码";
        }
        else if (_result.ExpectedCrc32 == _result.ReceivedCrc32)
        {
            CrcInfoBar.Severity = InfoBarSeverity.Success;
            CrcInfoBar.Title = $"共 {_result.Bundle.Count} 个文件";
            CrcInfoBar.Message = "CRC32 校验通过";
        }
        else
        {
            CrcInfoBar.Severity = InfoBarSeverity.Error;
            CrcInfoBar.Title = $"共 {_result.Bundle.Count} 个文件";
            CrcInfoBar.Message = "CRC32 校验失败";
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

    private async void OpenTextIfPossible(string name)
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
        if (!FileNameUtil.FitsTextUi(match.Size))
        {
            await UiMessages.InfoAsync("文件过大，请用「全部保存」后用其他应用打开。");
            return;
        }
        try
        {
            // Path-backed members read the ContentStore blob on demand; the
            // blob may already be gone (e.g. 清空所有 in the file list).
            byte[] preview = await Task.Run(() => match.Data);
            string? text = FileNameUtil.DecodeUtf8Strict(preview);
            if (text is null)
            {
                await UiMessages.InfoAsync("该文件不是有效的 UTF-8 文本，无法复制预览。");
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
        catch (Exception ex)
        {
            // async void 中逃逸的异常会绕过所有上层处理器直接崩溃进程，必须就地兜底。
            await UiMessages.ErrorAsync($"读取文件失败（源文件可能已被清理）: {ex.Message}");
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
        int saved = 0;
        try
        {
            Directory.CreateDirectory(dir);
            foreach (BundleFile f in _result.Bundle)
            {
                string target = FileNameUtil.UniqueRelativeTarget(dir, f.Name);
                await Task.Run(() => f.CopyTo(target));
                saved++;
            }
            // Members were already indexed atomically when recovery completed.
            // Saving is an export operation and must not create duplicate history
            // groups each time the button is clicked.
            await UiMessages.InfoAsync($"已保存 {saved} 个文件到:\n{dir}");
        }
        catch (Exception ex)
        {
            // async void 中逃逸的异常会绕过所有上层处理器直接崩溃进程，必须就地
            // 兜底；同时告知用户中断前已成功写盘的数量，便于手动补救。
            await UiMessages.ErrorAsync($"保存失败（已保存 {saved} 个）: {ex.Message}");
        }
    }

    private async void OpenFolder_Click(object sender, RoutedEventArgs e)
    {
        if (_result.Bundle is null)
        {
            return;
        }
        try
        {
            // ContentStore members are extensionless SHA-256 blobs. Export a
            // temporary, logically named directory before handing it to Explorer.
            string dir = ShareExport.ExportFiles(_result.Bundle);
            var startInfo = new ProcessStartInfo("explorer.exe")
            {
                UseShellExecute = true,
            };
            startInfo.ArgumentList.Add(dir);
            Process.Start(startInfo);
        }
        catch (Exception ex)
        {
            await UiMessages.ErrorAsync($"打开文件夹失败: {ex.Message}");
        }
    }

    private void Rescan_Click(object sender, RoutedEventArgs e) => NavigationService?.GoBack();

    private void Back_Click(object sender, RoutedEventArgs e) => NavigationService?.GoBack();

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
