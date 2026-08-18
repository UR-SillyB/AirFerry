using System.Windows;
using AirFerry.Windows.Bundle;
using AirFerry.Windows.Native;
using AirFerry.Windows.Views;

namespace AirFerry.Windows;

/// <summary>
/// Code-behind for App.xaml. Startup shows <see cref="MainWindow"/> — an
/// <c>hc:Window</c> hosting a Frame whose first page is <c>DeviceSelectView</c>
/// (the device-selection page — the user's first interaction), mirroring how
/// Android's launcher Activity is <c>ScanActivity</c>. Navigation between views
/// uses WPF's <c>NavigationService</c>, the WPF analogue of Android's
/// <c>Intent</c>-based Activity switching.
/// </summary>
public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        try
        {
            // Native ABI handshake (mirrors Android's ScanActivity check): a
            // stale transfer_engine.dll predating the snapshot ABI lacks
            // airferry_receiver_snapshot_json and would otherwise fail on the
            // first decoded QR frame with an EntryPointNotFoundException.
            uint abi = NativeBridge.NativeAbiVersion();
            if (abi < NativeBridge.NativeAbiVersion3)
            {
                Services.UiMessages.ErrorAsync(
                    $"原生引擎版本过旧（ABI v{abi}，需要 v{NativeBridge.NativeAbiVersion3}）。" +
                    "请重新安装最新版 AirFerry。");
                Shutdown(-1);
                return;
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or TypeInitializationException or EntryPointNotFoundException)
        {
            Services.UiMessages.ErrorAsync(
                "未找到原生引擎 transfer_engine.dll，请重新安装 AirFerry。\n" + ex.Message);
            Shutdown(-1);
            return;
        }
        try
        {
            ContentStore.MigrateLegacyReceivedIfNeeded();
        }
        catch
        {
            // Non-fatal
        }
        try
        {
            ShareExport.PruneExpired();
        }
        catch
        {
            // Non-fatal
        }
        // MainWindow's constructor applies the persisted theme preference.
        new MainWindow().Show();
    }
}
