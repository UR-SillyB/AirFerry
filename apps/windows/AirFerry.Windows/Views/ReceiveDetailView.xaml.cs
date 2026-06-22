using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using AirFerry.Windows.Models;
using AirFerry.Windows.ViewModels;
using Microsoft.Win32;

namespace AirFerry.Windows.Views;

/// <summary>
/// Single-file receive detail page — mirrors Android's
/// <c>ReceiveDetailActivity</c>: shows filename / size / CRC32 verification,
/// and offers "save to…", "share" (Explorer select), and "rescan".
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
        string displayName = Path.GetFileNameWithoutExtension(filePath);
        if (string.IsNullOrEmpty(displayName))
        {
            displayName = "received_file";
        }
        FileNameText.Text = displayName;

        ulong size = _result.SingleFileSize ?? 0;
        FileSizeText.Text = FormatSize(size);

        if (!_result.Crc32Known)
        {
            CrcStatusText.Text = "未提供校验码";
            CrcStatusText.Foreground = FindResource("TextSecondary") as Brush;
            CrcValuesText.Text = "";
        }
        else if (_result.ExpectedCrc32 == _result.ReceivedCrc32)
        {
            CrcStatusText.Text = "✓ 校验通过";
            CrcStatusText.Foreground = new SolidColorBrush(Color.FromRgb(0x22, 0xC5, 0x5E));
            CrcValuesText.Text = $"期望 0x{_result.ExpectedCrc32:X8}\n实际 0x{_result.ReceivedCrc32:X8}";
        }
        else
        {
            CrcStatusText.Text = "✗ 校验失败";
            CrcStatusText.Foreground = new SolidColorBrush(Color.FromRgb(0xEF, 0x44, 0x44));
            CrcValuesText.Text = $"期望 0x{_result.ExpectedCrc32:X8}\n实际 0x{_result.ReceivedCrc32:X8}";
        }
    }

    private void SaveAs_Click(object sender, RoutedEventArgs e)
    {
        string src = _result.SingleFilePath ?? "";
        if (!File.Exists(src))
        {
            return;
        }
        string displayName = Path.GetFileName(src);
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
            // Also archive a copy into the received directory.
            ScanViewModel.ArchiveSingleFile(src, displayName);
            MessageBox.Show("已保存", "AirFerry", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"保存失败: {ex.Message}", "AirFerry", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void Share_Click(object sender, RoutedEventArgs e)
    {
        string src = _result.SingleFilePath ?? "";
        if (!File.Exists(src))
        {
            return;
        }
        // Open Explorer with the file selected — Windows' closest analogue to
        // Android's share Intent for a single file.
        Process.Start("explorer.exe", $"/select,\"{src}\"");
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
