using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using AirFerry.Windows.Models;
using AirFerry.Windows.Services;
using AirFerry.Windows.Controls;
using Microsoft.Win32;

namespace AirFerry.Windows.Views;

/// <summary>
/// Text-message receive page — mirrors Android's <c>ReceiveTextActivity</c>:
/// shows the recovered text in a scrollable box with a copy-to-clipboard
/// primary action, plus "save as .txt" and "rescan". CRC verification is shown
/// the same way as a file (themed InfoBar).
/// </summary>
public partial class ReceiveTextView : Page
{
    private readonly RecoveryResult _result;
    private readonly string _saveFileName;

    public ReceiveTextView(RecoveryResult result, string? suggestedFileName = null)
    {
        InitializeComponent();
        _result = result;
        _saveFileName = string.IsNullOrWhiteSpace(suggestedFileName)
            ? "文字消息.txt"
            : (suggestedFileName.EndsWith(".txt", StringComparison.OrdinalIgnoreCase)
                ? suggestedFileName
                : suggestedFileName + ".txt");
        Loaded += (_, _) => Populate();
    }

    private void Populate()
    {
        ContentBox.Text = _result.Text ?? "";

        if (!_result.Crc32Known)
        {
            CrcInfoBar.Severity = InfoBarSeverity.Informational;
            CrcInfoBar.Title = "未提供校验码";
            CrcInfoBar.Message = "";
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

    /// <summary>Copy the recovered text to the Windows clipboard.</summary>
    private async void Copy_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            Clipboard.SetText(_result.Text ?? "");
            await UiMessages.InfoAsync("已复制到剪贴板");
        }
        catch (Exception ex)
        {
            await UiMessages.ErrorAsync($"复制失败: {ex.Message}");
        }
    }

    /// <summary>Save the text as a UTF-8 .txt via a SaveFileDialog.</summary>
    private async void SaveAs_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new SaveFileDialog
        {
            FileName = _saveFileName,
            Filter = "文本文件|*.txt|所有文件|*.*",
        };
        if (dlg.ShowDialog() != true)
        {
            return;
        }
        try
        {
            File.WriteAllText(dlg.FileName, _result.Text ?? "", new UTF8Encoding(false));
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

    private void Rescan_Click(object sender, RoutedEventArgs e)
    {
        NavigationService?.GoBack();
    }
}
