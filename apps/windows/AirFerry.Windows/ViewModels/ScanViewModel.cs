using System.ComponentModel;
using System.IO;
using System.Windows;
using AirFerry.Windows.Bundle;
using AirFerry.Windows.Models;
using AirFerry.Windows.Scan;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using OpenCvSharp;

namespace AirFerry.Windows.ViewModels;

/// <summary>
/// The scan-page state machine — the Windows counterpart of Android's
/// <c>ScanActivity</c>. Owns the <see cref="VideoCapture"/> (producer),
/// <see cref="QrDecodePool"/> (N parallel decoders + serialized ingest), and a
/// single <see cref="ReceiverSession"/> (the Rust RaptorQ engine). On completion
/// it assembles the bytes, trims RaptorQ zero-padding, verifies CRC, unpacks a
/// bundle if present, and stages the result for the detail/bundle views.
/// </summary>
/// <remarks>
/// <para>
/// <b>Threading model</b>: a dedicated producer thread pulls frames from the
/// camera and feeds the pool. The pool's workers do the ZXing decode in
/// parallel; ingest (the <see cref="ReceiverSession.Ingest"/> call) is
/// serialized inside the pool under <see cref="QrDecodePool.IngestLock"/>. The
/// final assemble also runs under that lock (via <see cref="QrDecodePool.RunExclusive{T}"/>)
/// so no straggler ingest can race the borrow.
/// </para>
/// <para>
/// <b>Files land in</b> <c>%USERPROFILE%\Documents\AirFerry\received\</c> — the
/// Windows equivalent of Android's <c>getExternalFilesDir/received/</c>.
/// </para>
/// </remarks>
public partial class ScanViewModel : ObservableObject, IDisposable
{
    private AirFerry.Windows.Scan.VideoCapture? _capture;
    private QrDecodePool? _pool;
    private ReceiverSession? _session;
    private Thread? _producerThread;
    private volatile bool _producerRunning;
    private bool _disposed;

    /// <summary>The device index chosen in the device-select page.</summary>
    [ObservableProperty]
    private int _selectedDeviceIndex;

    [ObservableProperty]
    private string _statusText = "等待扫码…";

    [ObservableProperty]
    private double _progress;

    [ObservableProperty]
    private string _receivedSymbolsText = "0";

    [ObservableProperty]
    private string _totalSymbolsText = "0";

    [ObservableProperty]
    private string _lossRatioText = "0.0%";

    [ObservableProperty]
    private string _recoveryStageText = string.Empty;

    [ObservableProperty]
    private bool _isComplete;

    [ObservableProperty]
    private bool _isRecovering;

    /// <summary>Raised when a transfer finishes recovering — carries the result.</summary>
    public event Action<RecoveryResult>? TransferCompleted;

    /// <summary>Directory where recovered files are archived.</summary>
    public static string ReceivedDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            "AirFerry", "received");

    /// <summary>Temp dir for staging recovered bytes before archive.</summary>
    private static string TempDir => Path.Combine(Path.GetTempPath(), "AirFerry");

    /// <summary>
    /// Start the pipeline on <paramref name="deviceIndex"/>. Idempotent —
    /// calling while running first stops the previous session.
    /// </summary>
    [RelayCommand]
    public void StartScan(int deviceIndex)
    {
        StopScan();
        SelectedDeviceIndex = deviceIndex;

        _session = new ReceiverSession();
        _capture = new Scan.VideoCapture(deviceIndex);
        if (!_capture.IsOpen)
        {
            StatusText = "无法打开设备，请检查是否被其他程序占用";
            return;
        }

        // The onDecoded callback runs under the pool's IngestLock. Returns true
        // when this symbol completes recovery so the pool stops ingesting.
        _pool = new QrDecodePool(payload => OnDecoded(payload));
        _pool.Start();

        // Producer thread: pull frames and enqueue them. The pool handles the
        // drop-newest backpressure when workers can't keep up.
        _producerRunning = true;
        _producerThread = new Thread(ProducerLoop)
        {
            IsBackground = true,
            Name = "video-producer",
        };
        _producerThread.Start();

        StatusText = "正在扫描…对准屏幕上的二维码";
    }

    [RelayCommand]
    public void StopScan()
    {
        _producerRunning = false;
        _producerThread?.Join(TimeSpan.FromSeconds(2));
        _producerThread = null;
        _pool?.Dispose();
        _pool = null;
        _capture?.Dispose();
        _capture = null;
        _session?.Dispose();
        _session = null;
        IsRecovering = false;
        if (!IsComplete)
        {
            Progress = 0;
            ReceivedSymbolsText = "0";
        }
    }

    /// <summary>
    /// Reset for a fresh scan: clear completion + progress so a new transfer can
    /// start from zero.
    /// </summary>
    [RelayCommand]
    public void ResetSession()
    {
        StopScan();
        IsComplete = false;
        Progress = 0;
        ReceivedSymbolsText = "0";
        TotalSymbolsText = "0";
        LossRatioText = "0.0%";
        RecoveryStageText = string.Empty;
        StatusText = "等待扫码…";
    }

    /// <summary>Producer: read grayscale frames and feed the decode pool.</summary>
    private void ProducerLoop()
    {
        while (_producerRunning && _capture is not null && _pool is not null)
        {
            Mat? gray = _capture.ReadGray();
            if (gray is null)
            {
                // Camera exhausted — a few nulls in a row means the device died.
                continue;
            }
            // Submit clones the pixels; the Mat itself is reused by VideoCapture.
            _pool.Submit(gray);
        }
    }

    /// <summary>
    /// Per-frame ingest callback (runs under <see cref="QrDecodePool.IngestLock"/>).
    /// Returns true when this symbol completes recovery.
    /// </summary>
    private bool OnDecoded(byte[] payload)
    {
        if (_pool is null || _pool.IngestStopped || _session is null)
        {
            return false;
        }
        IngestStatus? status = _session.Ingest(payload);
        if (status is null)
        {
            return false;
        }
        IngestStatus s = status.Value;

        // Update UI counters on the UI thread.
        System.Windows.Application.Current?.Dispatcher.BeginInvoke(() =>
        {
            ReceivedSymbolsText = s.ReceivedSymbols.ToString();
            if (_session.EstimatedTotalSymbols > 0)
            {
                TotalSymbolsText = _session.EstimatedTotalSymbols.ToString();
            }
        });

        if (s.Complete)
        {
            // Trigger recovery on a background thread (assemble is heavy).
            System.Windows.Application.Current?.Dispatcher.BeginInvoke(() =>
            {
                IsComplete = true;
                RecoverAndStage();
            });
            return true;
        }
        return false;
    }

    /// <summary>
    /// Assemble + verify + stage the recovered bytes. Mirrors Android's
    /// <c>recoverAndStage</c> step by step.
    /// </summary>
    private void RecoverAndStage()
    {
        if (_session is null || _pool is null)
        {
            return;
        }
        IsRecovering = true;
        RecoveryStageText = "正在组装数据…";

        // Assemble under the ingest lock so no straggler worker races the borrow.
        byte[]? bytes = _pool.RunExclusive(() => _session.Assemble());
        if (bytes is null || bytes.Length == 0)
        {
            IsRecovering = false;
            RecoveryStageText = string.Empty;
            StatusText = "组装失败";
            return;
        }

        RecoveryStageText = "正在校验完整性…";
        ulong expectedCrc = _session.Crc32();
        bool crcKnown = _session.Crc32Known();
        ulong receivedCrc = Crc32.Compute(bytes);
        string displayName = _session.FileName();
        ulong originalSize = _session.FileSize();

        // Stop the pool now that recovery is done.
        _pool.IngestStopped = true;

        RecoveryResult? result;
        if (TextParser.IsText(bytes))
        {
            // Text payload → decode UTF-8 and carry the string in-memory. No
            // file is written to disk; the user copies / shares / saves from
            // the text view. Checked BEFORE the bundle branch: the two magics
            // never collide ("ETTEXTv1" vs "ETBUNDL1"). If decoding fails, fall
            // through to single-file handling so the user still gets something.
            string? text = TextParser.Parse(bytes);
            result = text is not null
                ? new RecoveryResult(
                    SingleFilePath: null,
                    SingleFileSize: null,
                    ExpectedCrc32: expectedCrc,
                    Crc32Known: crcKnown,
                    ReceivedCrc32: receivedCrc,
                    Bundle: null,
                    BundleDir: null,
                    Text: text)
                : StageSingleFile(bytes, displayName, originalSize,
                    expectedCrc, crcKnown, receivedCrc);
        }
        else if (BundleParser.IsBundle(bytes))
        {
            result = StageBundle(bytes, expectedCrc, crcKnown, receivedCrc);
            // If parsing failed, fall through to single-file handling.
            result ??= StageSingleFile(bytes, displayName, originalSize,
                expectedCrc, crcKnown, receivedCrc);
        }
        else if (FileNameUtil.IsTextLikeName(
                     string.IsNullOrEmpty(displayName) ? "received_file" : displayName)
                 && FileNameUtil.FitsTextUi(bytes.LongLength))
        {
            // Single text-like document (readme.md, notes.json, …): open the
            // copy/share UI only when the payload is valid UTF-8 and small enough
            // for the in-memory text view. Still stage a temp file so save-as
            // can use the original name.
            string? text = FileNameUtil.DecodeUtf8Strict(bytes);
            result = text is not null
                ? StageTextLikeFile(bytes, displayName, originalSize,
                    expectedCrc, crcKnown, receivedCrc, text)
                : StageSingleFile(bytes, displayName, originalSize,
                    expectedCrc, crcKnown, receivedCrc);
        }
        else
        {
            result = StageSingleFile(bytes, displayName, originalSize,
                expectedCrc, crcKnown, receivedCrc);
        }

        IsRecovering = false;
        RecoveryStageText = string.Empty;
        StatusText = "接收完成";
        TransferCompleted?.Invoke(result);
    }

    private RecoveryResult StageSingleFile(byte[] bytes, string displayName,
        ulong originalSize, ulong expectedCrc, bool crcKnown, ulong receivedCrc)
    {
        string finalName = string.IsNullOrEmpty(displayName) ? "received_file" : displayName;
        string crcHex = crcKnown ? expectedCrc.ToString("x") : "unknown";
        ContentStore.PutResult put = ContentStore.PutBytes(
            finalName, bytes, crcHex, crcUnknown: !crcKnown, kind: "file");
        return new RecoveryResult(
            SingleFilePath: put.Path,
            SingleFileSize: originalSize > 0 ? originalSize : (ulong)bytes.Length,
            ExpectedCrc32: expectedCrc,
            Crc32Known: crcKnown,
            ReceivedCrc32: receivedCrc,
            Bundle: null,
            BundleDir: null);
    }

    /// <summary>
    /// Stage a text-like single file into ContentStore and keep text for the copy UI.
    /// </summary>
    private RecoveryResult StageTextLikeFile(byte[] bytes, string displayName,
        ulong originalSize, ulong expectedCrc, bool crcKnown, ulong receivedCrc, string text)
    {
        string finalName = string.IsNullOrEmpty(displayName) ? "文字消息.txt" : displayName;
        ContentStore.PutResult put = ContentStore.PutBytes(
            finalName, bytes, crcHex: "unknown", crcUnknown: true, kind: "text");
        return new RecoveryResult(
            SingleFilePath: put.Path,
            SingleFileSize: originalSize > 0 ? originalSize : (ulong)bytes.Length,
            ExpectedCrc32: expectedCrc,
            Crc32Known: crcKnown,
            ReceivedCrc32: receivedCrc,
            Bundle: null,
            BundleDir: null,
            Text: text);
    }

    private RecoveryResult? StageBundle(byte[] bytes, ulong expectedCrc,
        bool crcKnown, ulong receivedCrc)
    {
        AirFerry.Windows.Bundle.Bundle? bundle = BundleParser.Parse(bytes);
        if (bundle is null || bundle.Files.Count == 0)
        {
            return null;
        }
        string bundleId = Guid.NewGuid().ToString("N");
        string bundleTitle = $"发送_{DateTime.Now:MMdd_HHmmss}";
        var staged = new List<BundleFile>(bundle.Files.Count);
        int idx = 0;
        foreach (BundleFile f in bundle.Files)
        {
            idx++;
            RecoveryStageText = $"正在保存文件 ({idx}/{bundle.Files.Count})…";
            ContentStore.PutResult put = ContentStore.PutBytes(
                f.Name, f.Data, kind: "file",
                bundleId: bundleId, bundleTitle: bundleTitle);
            // Keep in-memory bytes for the bundle UI; disk is content-addressed.
            staged.Add(new BundleFile(f.Name, f.Data));
            _ = put;
        }
        return new RecoveryResult(
            SingleFilePath: null,
            SingleFileSize: null,
            ExpectedCrc32: expectedCrc,
            Crc32Known: crcKnown,
            ReceivedCrc32: receivedCrc,
            Bundle: staged,
            BundleDir: null);
    }

    /// <summary>
    /// Periodically poll progress for the live UI (called by a timer at ~7 Hz).
    /// Keeps the hot ingest path allocation-free.
    /// </summary>
    public void RefreshProgress()
    {
        if (_session is null || !_session.IsInitialized || IsComplete)
        {
            return;
        }
        ProgressSnapshot? snap = _session.Progress();
        if (snap is null)
        {
            return;
        }
        ProgressSnapshot p = snap.Value;
        if (p.TotalSymbols > 0)
        {
            Progress = p.DecodedFraction * 100.0;
            TotalSymbolsText = p.TotalSymbols.ToString();
        }
        ReceivedSymbolsText = p.ReceivedSymbols.ToString();
        LossRatioText = $"{p.LossRatio * 100:F1}%";
    }

    /// <summary>
    /// Ensure <paramref name="sourcePath"/> is in ContentStore (idempotent if already a blob).
    /// Returns the canonical blob path.
    /// </summary>
    public static string ArchiveSingleFile(string sourcePath, string displayName)
    {
        if (File.Exists(sourcePath) &&
            sourcePath.StartsWith(ContentStore.RootDir, StringComparison.OrdinalIgnoreCase))
        {
            return sourcePath;
        }
        byte[] bytes = File.Exists(sourcePath) ? File.ReadAllBytes(sourcePath) : [];
        return ContentStore.PutBytes(displayName, bytes).Path;
    }

    /// <summary>Archive a bundle into ContentStore (content-addressed members).</summary>
    public static string ArchiveBundle(IReadOnlyList<BundleFile> files)
    {
        string bundleId = Guid.NewGuid().ToString("N");
        string bundleTitle = $"发送_{DateTime.Now:MMdd_HHmmss}";
        string? first = null;
        foreach (BundleFile f in files)
        {
            var put = ContentStore.PutBytes(
                f.Name, f.Data, kind: "file",
                bundleId: bundleId, bundleTitle: bundleTitle);
            first ??= put.Path;
        }
        return first ?? ContentStore.RootDir;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        StopScan();
    }
}
