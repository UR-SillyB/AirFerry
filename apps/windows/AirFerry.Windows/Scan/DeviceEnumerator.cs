using System.Runtime.InteropServices;
using AirFerry.Windows.Models;
using DirectShowLib;

namespace AirFerry.Windows.Scan;

/// <summary>
/// Enumerates video-input devices via DirectShow — the Windows equivalent of
/// Android's <c>CameraX</c> device discovery. This is the host of the
/// user-requested "device selection" feature: webcams and capture cards
/// (USB/HDMI/SDI) both surface as <c>FilterCategory.VideoInputDevice</c>, so one
/// enumeration covers both and the user picks from a dropdown.
/// </summary>
/// <remarks>
/// <para>
/// Capture-card detection is heuristic: DirectShow doesn't tag a device as
/// "card vs. webcam", so we match friendly-name keywords. The label is cosmetic
/// — the capture path (<see cref="VideoCapture"/>) treats both device kinds
/// identically.
/// </para>
/// <para>
/// COM is initialized to <c>MultiNoWait</c> for the duration of the enumeration
/// call so <c>DsDevice.GetDevicesOfCat</c> can talk to the DirectShow COM APIs
/// regardless of the calling thread's apartment state.
/// </para>
/// </remarks>
public static class DeviceEnumerator
{
    // Names containing any of these (case-insensitive) are labelled capture
    // cards. Tuned for the common vendors / generic descriptions — not
    // exhaustive, purely informational.
    private static readonly string[] CaptureCardKeywords =
    [
        "capture", "采集", "magewell", "avermedia", "elgato", "blackmagic",
        "decklink", "intensity", "cam link", "utv", "hdmi", "sdi", "ms2109",
        "ms2100", "ms2130", "ezcap", "genki", "ivcam",
    ];

    /// <summary>
    /// List all video-input devices. Returns an empty list (not null) if none
    /// are attached or enumeration fails — the UI shows an "attach a device"
    /// message rather than throwing.
    /// </summary>
    public static IReadOnlyList<DeviceInfo> Enumerate()
    {
        // DirectShow enumeration requires an STA-equivalent context. Force the
        // right apartment here so callers from any thread work.
        if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
        {
            IReadOnlyList<DeviceInfo> result = Array.Empty<DeviceInfo>();
            Thread sta = new(() => result = EnumerateCore())
            {
                IsBackground = true,
                Name = "DeviceEnum",
            };
            sta.SetApartmentState(ApartmentState.STA);
            sta.Start();
            sta.Join();
            return result;
        }
        return EnumerateCore();
    }

    private static IReadOnlyList<DeviceInfo> EnumerateCore()
    {
        try
        {
            DsDevice[] ds = DsDevice.GetDevicesOfCat(FilterCategory.VideoInputDevice);
            if (ds.Length == 0)
            {
                return Array.Empty<DeviceInfo>();
            }
            var list = new DeviceInfo[ds.Length];
            for (int i = 0; i < ds.Length; i++)
            {
                string name = ds[i].Name ?? $"Device {i}";
                // DirectShowLib.Standard doesn't expose MonikerString; use
                // index as identifier (VideoCapture binds by index).
                string moniker = i.ToString();
                bool isCard = LooksLikeCaptureCard(name);
                list[i] = new DeviceInfo(name, moniker, i, isCard);
            }
            return list;
        }
        catch (COMException)
        {
            // No DirectShow / no devices — surface an empty list, not a crash.
            return Array.Empty<DeviceInfo>();
        }
    }

    private static bool LooksLikeCaptureCard(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }
        foreach (string keyword in CaptureCardKeywords)
        {
            if (name.Contains(keyword, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }
}
