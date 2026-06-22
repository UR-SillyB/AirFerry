using OpenCvSharp;

namespace AirFerry.Windows.Scan;

/// <summary>
/// Frames a single video device for the scan pipeline. The Windows counterpart
/// of Android's <c>CameraX + QrStreamAnalyzer</c>: bind a webcam or capture
/// card (DirectShow backend), pull frames at a target resolution, and hand the
/// decoder a grayscale luminance image — the same modality Android's Y plane
/// provides, so <see cref="ZxingDecoder"/> is fed identically on both hosts.
/// </summary>
/// <remarks>
/// <para>
/// Devices are opened by the 0-based index returned by
/// <see cref="DeviceEnumerator"/> (DirectShow's native addressing). The
/// moniker-string path is kept as a future enhancement but OpenCvSharp's
/// DirectShow backend currently binds by index, so the index is authoritative.
/// </para>
/// <para>
/// <b>Resolution</b>: defaults to 1920×1080 at 60 fps to match Android's
/// <c>ResolutionStrategy(CLOSEST_HIGHER_THEN_LOWER)</c> + 60 fps AE target. If
/// the device doesn't support those caps DirectShow picks the nearest, exactly
/// as CameraX does.
/// </para>
/// <para>
/// <b>Threading</b>: <see cref="ReadGray"/> / <see cref="ReadBgr"/> are
/// <b>not</b> thread-safe — only the single producer thread in
/// <see cref="QrDecodePool"/> calls them.
/// </para>
/// </remarks>
public sealed class VideoCapture : IDisposable
{
    private readonly OpenCvSharp.VideoCapture _cap;
    private readonly Mat _bgr = new();
    private readonly Mat _gray = new();
    private bool _disposed;

    /// <summary>Width/height the device actually delivers (0 until first read).</summary>
    public int Width { get; private set; }
    public int Height { get; private set; }

    public bool IsOpen => !_disposed && _cap.IsOpened();

    /// <summary>
    /// Open <paramref name="deviceIndex"/> with the given caps. Returns false
    /// (does not throw) on failure so the UI can prompt "device in use?".
    /// </summary>
    public VideoCapture(int deviceIndex, int width = 1920, int height = 1080, int fps = 60)
    {
        _cap = new OpenCvSharp.VideoCapture(deviceIndex, VideoCaptureAPIs.DSHOW);
        if (_cap.IsOpened())
        {
            _cap.FrameWidth = width;
            _cap.FrameHeight = height;
            _cap.Fps = fps;
            // Buffersize keeps DirectShow's internal queue shallow so a stalled
            // decoder drops old frames rather than delivering them late (mirrors
            // CameraX's STRATEGY_KEEP_ONLY_LATEST).
            _cap.Buffersize = 1;
        }
    }

    /// <summary>
    /// Read one frame and convert to grayscale (luminance). Returns null when
    /// the device is exhausted/closed — the caller should treat repeated nulls
    /// as a fatal device error. The returned <see cref="Mat"/> is owned by this
    /// object (reused across calls); callers must clone before holding a
    /// reference across the next read.
    /// </summary>
    public Mat? ReadGray()
    {
        if (_disposed || !_cap.IsOpened())
        {
            return null;
        }
        bool ok = _cap.Read(_bgr);
        if (!ok || _bgr.Empty())
        {
            return null;
        }
        Width = _bgr.Width;
        Height = _bgr.Height;
        Cv2.CvtColor(_bgr, _gray, ColorConversionCodes.BGR2GRAY);
        return _gray;
    }

    /// <summary>
    /// Read one frame in BGR (for the preview overlay). Like <see cref="ReadGray"/>
    /// the returned Mat is reused — clone it if you need to keep it.
    /// </summary>
    public Mat? ReadBgr()
    {
        if (_disposed || !_cap.IsOpened())
        {
            return null;
        }
        bool ok = _cap.Read(_bgr);
        if (!ok || _bgr.Empty())
        {
            return null;
        }
        Width = _bgr.Width;
        Height = _bgr.Height;
        return _bgr;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        _gray.Dispose();
        _bgr.Dispose();
        _cap.Dispose();
    }
}
