using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using AirFerry.Windows.Models;
using Microsoft.Win32;

namespace AirFerry.Windows.Views;

/// <summary>
/// Text-message receive page — mirrors Android's <c>ReceiveTextActivity</c>:
/// shows the recovered text in a scrollable box with a copy-to-clipboard
/// primary action, plus "save as .txt" and "rescan". CRC verification is shown
/// the same way as a file.
/// </summary>
public partial class ReceiveTextView : Page
{
    private readonly RecoveryResult _result;

    public ReceiveTextView(RecoveryResult result)
    {
        InitializeComponent();
        _result = result;
        Loaded += (_, _) => Populate();
    }

    private void Populate()
    {
        ContentBox.Text = _result.Text ?? "";

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

    /// <summary>Copy the recovered text to the Windows clipboard.</summary>
    private void Copy_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            Clipboard.SetText(_result.Text ?? "");
            MessageBox.Show("已复制到剪贴板", "AirFerry", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"复制失败: {ex.Message}", "AirFerry", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    /// <summary>Save the text as a UTF-8 .txt via a SaveFileDialog.</summary>
    private void SaveAs_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new SaveFileDialog
        {
            FileName = "文字消息.txt",
            Filter = "文本文件|*.txt|所有文件|*.*",
        };
        if (dlg.ShowDialog() != true)
        {
            return;
        }
        try
        {
            File.WriteAllText(dlg.FileName, _result.Text ?? "", new UTF8Encoding(false));
            MessageBox.Show("已保存", "AirFerry", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"保存失败: {ex.Message}", "AirFerry", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void Rescan_Click(object sender, RoutedEventArgs e)
    {
        NavigationService?.GoBack();
    }
}
