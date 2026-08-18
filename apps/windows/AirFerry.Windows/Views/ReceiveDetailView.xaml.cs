using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using AirFerry.Windows.Bundle;
using AirFerry.Windows.Models;
using AirFerry.Windows.Services;
using AirFerry.Windows.ViewModels;
using AirFerry.Windows.Controls;
using Microsoft.Win32;

namespace AirFerry.Windows.Views;

/// <summary>
/// Single-file receive detail page — mirrors Android's
/// <c>ReceiveDetailActivity</c>: shows filename / size / integrity
/// verification (themed InfoBar), and offers "save to…", "open folder"
/// (Explorer selects the logically named export), and "rescan".
/// </summary>
public partial class ReceiveDetailView : Page
{
    private readonly RecoveryResult _result;

    public ReceiveDetailView(RecoveryResult result)
    {
        InitializeComponent();
        _result = result;
        Loaded += (_, _) => Populate();
    }

    private void Populate()
    {
        string filePath = _result.SingleFilePath ?? "";
        string displayName = !string.IsNullOrWhiteSpace(_result.DisplayName)
            ? _result.DisplayName
            : Path.GetFileName(filePath);
        if (string.IsNullOrEmpty(displayName))
        {
            displayName = "received_file";
        }
        FileNameText.Text = displayName;

        ulong size = _result.SingleFileSize ?? 0;
        FileSizeText.Text = FormatSize(size);

        if (!_result.Crc32Known)
        {
            CrcInfoBar.Severity = InfoBarSeverity.Informational;
            CrcInfoBar.Title = "未提供校验码";
            CrcInfoBar.Message = "";
        }
        else if (_result.ReceivedCrc32 is null)
        {
            // >256 MiB 流式入库路径不把整份文件读进内存，无法计算实际 CRC32
            // （ReceivedCrc32 为 null），但入库时已按描述符校验过整文件
            // SHA-256 —— 按校验通过展示，勿落入「校验失败」假阴性。
            CrcInfoBar.Severity = InfoBarSeverity.Success;
            CrcInfoBar.Title = "已通过 SHA-256 校验";
            CrcInfoBar.Message =
                $"期望 0x{_result.ExpectedCrc32:X8}\n实际 —（超大文件流式接收，未计算 CRC32）";
        }
        else if (_result.ExpectedCrc32 == _result.ReceivedCrc32)
        {
            CrcInfoBar.Severity = InfoBarSeverity.Success;
            CrcInfoBar.Title = "CRC32 校验通过";
            CrcInfoBar.Message = $"期望 0x{_result.ExpectedCrc32:X8}\n实际 0x{_result.ReceivedCrc32:X8}";
        }
        else
        {
            CrcInfoBar.Severity = InfoBarSeverity.Error;
            CrcInfoBar.Title = "CRC32 校验失败";
            CrcInfoBar.Message = $"期望 0x{_result.ExpectedCrc32:X8}\n实际 0x{_result.ReceivedCrc32:X8}";
        }
    }

    private async void SaveAs_Click(object sender, RoutedEventArgs e)
    {
        string src = _result.SingleFilePath ?? "";
        if (!File.Exists(src))
        {
            return;
        }
        string displayName = !string.IsNullOrWhiteSpace(_result.DisplayName)
            ? _result.DisplayName
            : Path.GetFileName(src);
        var dlg = new SaveFileDialog
        {
            FileName = displayName,
            Filter = "所有文件|*.*",
        };
        if (dlg.ShowDialog() != true)
        {
            return;
        }
        try
        {
            File.Copy(src, dlg.FileName, overwrite: true);
            // ContentStore is idempotent when src is already a canonical blob.
            ScanViewModel.ArchiveSingleFile(src, displayName);
            // Inline confirmation on the button itself — a modal "已保存"
            // dialog interrupts the post-receive flow for no reason.
            SaveButton.Content = "已保存";
            SaveButton.IsEnabled = false;
        }
        catch (Exception ex)
        {
            await UiMessages.ErrorAsync($"保存失败: {ex.Message}");
        }
    }

    private void Back_Click(object sender, RoutedEventArgs e)
    {
        NavigationService?.GoBack();
    }

    private async void OpenFolder_Click(object sender, RoutedEventArgs e)
    {
        string src = _result.SingleFilePath ?? "";
        if (!File.Exists(src))
        {
            return;
        }
        try
        {
            string displayName = !string.IsNullOrWhiteSpace(_result.DisplayName)
                ? _result.DisplayName
                : "received_file";
            // Never expose the extensionless SHA-256 ContentStore blob. Explorer
            // receives a temporary copy carrying the logical filename instead.
            // The copy can be a full GB-scale file — keep it off the UI thread.
            string exported = await Task.Run(() => ShareExport.ExportFile(src, displayName));
            var startInfo = new ProcessStartInfo("explorer.exe")
            {
                UseShellExecute = true,
            };
            startInfo.ArgumentList.Add($"/select,{exported}");
            Process.Start(startInfo);
        }
        catch (Exception ex)
        {
            await UiMessages.ErrorAsync($"打开文件夹失败: {ex.Message}");
        }
    }

    private void Rescan_Click(object sender, RoutedEventArgs e)
    {
        NavigationService?.GoBack();
    }

    private static string FormatSize(ulong bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024.0:F1} KB",
        < 1024UL * 1024 * 1024 => $"{bytes / (1024.0 * 1024):F1} MB",
        _ => $"{bytes / (1024.0 * 1024 * 1024):F2} GB",
    };
}
