using System.Windows;

namespace AirFerry.Windows.Services;

/// <summary>
/// Themed message dialogs (HandyControl <c>MessageBox</c>) replacing the stock
/// Win32 <c>System.Windows.MessageBox</c>, which ignores the skin. HC's
/// MessageBox is SYNCHRONOUS modal (it pumps its own dispatcher loop like the
/// Win32 box), so calling it on the UI thread is safe; the async signatures
/// are kept so existing call sites (24 awaits) compile unchanged. HC 3.5.1's
/// static API cannot customize button captions — buttons always read
/// 确定/取消 (HC's neutral Lang is Chinese), so the old "primaryText"
/// parameter is gone; destructive confirms get the warning icon instead.
/// </summary>
public static class UiMessages
{
    public static Task InfoAsync(string content, string title = "AirFerry")
    {
        HandyControl.Controls.MessageBox.Info(content, title);
        return Task.CompletedTask;
    }

    public static Task ErrorAsync(string content, string title = "AirFerry")
    {
        HandyControl.Controls.MessageBox.Error(content, title);
        return Task.CompletedTask;
    }

    /// <summary>Confirmation dialog; true when the user picks 确定 (OK).</summary>
    public static Task<bool> ConfirmAsync(string content, string title = "AirFerry",
        bool danger = false)
    {
        MessageBoxResult result = danger
            ? HandyControl.Controls.MessageBox.Show(content, title,
                MessageBoxButton.OKCancel, MessageBoxImage.Warning, MessageBoxResult.Cancel)
            : HandyControl.Controls.MessageBox.Ask(content, title);
        return Task.FromResult(result == MessageBoxResult.OK);
    }
}
