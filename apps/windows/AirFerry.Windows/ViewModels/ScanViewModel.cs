using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using AirFerry.Windows.Bundle;
using AirFerry.Windows.Models;
using AirFerry.Windows.Scan;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using OpenCvSharp;

namespace AirFerry.Windows.ViewModels;

/// <summary>
/// The scan-page state machine — the Windows counterpart of Android's
/// <c>ScanActivity</c>. Owns the <see cref="IFrameSource"/> (producer — a
/// DirectShow device, a screen rectangle or a window), <see cref="QrDecodePool"/>
/// (N parallel decoders + serialized ingest), and a single
/// <see cref="ReceiverSession"/> (the Rust RaptorQ engine). On completion
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
/// so no straggler ingest can race the borrow. The recovery task remains part
/// of the session lifetime: teardown waits for it and all workers before
/// destroying the native receiver.
/// </para>
/// <para>
/// <b>Files land in</b> the content-addressed <see cref="ContentStore"/> under
/// <c>%USERPROFILE%\Documents\AirFerry\store\</c>.
/// </para>
/// </remarks>
public partial class ScanViewModel : ObservableObject, IDisposable
{
    private IFrameSource? _capture;
    private QrDecodePool? _pool;
    private ReceiverSession? _session;
    private Thread? _producerThread;
    private volatile bool _producerRunning;
    private bool _disposed;
    private int _recoveryStarted;
    private int _sessionEpoch;
    private readonly object _lifecycleGate = new();
    private Task<RecoveryOutcome>? _recoveryCoreTask;
    private Task _deferredCleanupTask = Task.CompletedTask;
    private readonly Queue<RateSample> _rateSamples = new();
    private long _transferStartTimestamp;
    private long _decodePerSecond;
    private long _recentWireBytesPerSecond;
    private const int PreviewFps = 15;
    private const int RateWindowSeconds = 3;
    private const int RateMinMilliseconds = 500;
    private string? _resumeRootId;
    /// <summary>Disk-backed assembler for a descriptor-v5 large transfer (null = none).</summary>
    private AirFerry.Windows.Bundle.SegmentAssembler? _segAssembler;
    /// <summary>
    /// Child sessions already stored by this scan. The sender keeps replaying a
    /// completed segment until the operator advances; the fresh receiver used for
    /// the next segment must not re-initialize to it (issue #8). Cleared at the
    /// start of every scan.
    /// </summary>
    private readonly CompletedSegmentTracker _completedSegments = new();
    /// <summary>Continuous-receive folder sink (null = single-receive mode).</summary>
    private AirFerry.Windows.Bundle.ContinuousSaver? _continuousSaver;

    private sealed record AssembledPayload(
        byte[] Bytes,
        ulong ExpectedCrc,
        bool CrcKnown,
        string DisplayName,
        ulong OriginalSize);

    private readonly record struct RateSample(
        long Timestamp, long DecodedSymbols, long ReceivedSymbols);

    private readonly record struct LiveSnapshot(
        ProgressSnapshot? Progress,
        string FileName,
        ulong FileSize,
        uint SymbolSize,
        int EstimatedTotalSymbols);

    public ScanViewModel(string? resumeRootId = null)
    {
        if (resumeRootId is null) return;
        string normalized = resumeRootId.Trim().ToLowerInvariant();
        if (normalized.Length != 32 || normalized.Any(c => !Uri.IsHexDigit(c)))
            throw new ArgumentException("待恢复任务 ID 无效", nameof(resumeRootId));
        _resumeRootId = normalized;
    }

    /// <summary>The frame source chosen in the device-select page.</summary>
    [ObservableProperty]
    private ScanSource? _selectedSource;

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

    [ObservableProperty]
    private bool _isScanning;

    [ObservableProperty]
    private string _scanMetricsText = "采集 0 帧 · 丢弃 0 帧 · 解码 0 码";

    [ObservableProperty]
    private string _fileSummaryText = "等待描述符…";

    [ObservableProperty]
    private string _transferMetricsText = "解码 0 符号/秒 · 有效 0 B/s · 用时 00:00";

    /// <summary>Raised when a transfer finishes recovering — carries the result.</summary>
    public event Action<RecoveryResult>? TransferCompleted;

    /// <summary>
    /// Raised by the producer thread at most <see cref="PreviewFps"/> times per
    /// second. Subscribers must marshal rendering to their UI dispatcher.
    /// </summary>
    public event Action<PreviewFrame>? PreviewFrameReady;

    /// <summary>One entry in the continuous-receive feed (newest first).</summary>
    public enum ContinuousItemStatus { Saved, Skipped, Failed }

    public sealed record ContinuousReceivedItem(
        string TimeText,
        string Name,
        string SizeText,
        ContinuousItemStatus Status,
        string? Error = null)
    {
        /// <summary>Preformatted feed line for the ItemsControl template.</summary>
        public string Line => Status switch
        {
            ContinuousItemStatus.Skipped => $"{TimeText}  {Name} · 重复，已跳过",
            ContinuousItemStatus.Failed => $"{TimeText}  {Name} · 保存失败: {Error}",
            _ => $"{TimeText}  {Name} · {SizeText}",
        };
    }

    /// <summary>
    /// Continuous mode: on completion do not navigate — save into the chosen
    /// folder, re-arm a fresh receiver and keep scanning for the next file.
    /// </summary>
    public bool ContinuousMode { get; private set; }

    public string ContinuousSaveDir => _continuousSaver?.TargetDir ?? string.Empty;

    public int ContinuousSavedCount { get; private set; }

    public int ContinuousSkippedCount { get; private set; }

    /// <summary>Most-recent-first feed of continuous saves (dispatcher thread only).</summary>
    public ObservableCollection<ContinuousReceivedItem> ContinuousItems { get; } = [];

    public string ContinuousSummaryText =>
        ContinuousMode || ContinuousSavedCount > 0 || ContinuousSkippedCount > 0
            ? $"已保存 {ContinuousSavedCount} 份 · 跳过 {ContinuousSkippedCount} 份重复"
            : string.Empty;

    /// <summary>
    /// Point continuous mode at a folder and enable it. Re-enabling with the
    /// same folder keeps the dedup set (a toggled-off period does not forget
    /// what was already saved); a different folder starts fresh.
    /// </summary>
    public void SetContinuousDir(string dir)
    {
        bool sameDir = _continuousSaver is not null && string.Equals(
            _continuousSaver.TargetDir, dir, StringComparison.OrdinalIgnoreCase);
        if (!sameDir)
        {
            _continuousSaver = new AirFerry.Windows.Bundle.ContinuousSaver(dir);
            ContinuousSavedCount = 0;
            ContinuousSkippedCount = 0;
            ContinuousItems.Clear();
        }
        ContinuousMode = true;
    }

    public void DisableContinuous()
    {
        // Keep the saver instance: toggling back on with the same folder
        // continues to dedup against earlier saves.
        ContinuousMode = false;
    }


    /// <summary>Legacy archive directory, retained only for one-time migration.</summary>
    public static string ReceivedDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            "AirFerry", "received");

    /// <summary>Temp dir for staging recovered bytes before archive.</summary>
    private static string TempDir => Path.Combine(Path.GetTempPath(), "AirFerry");

    /// <summary>
    /// Start the pipeline on <paramref name="source"/> (device, screen region
    /// or window). Idempotent — calling while running first stops the previous
    /// session.
    /// </summary>
    [RelayCommand]
    public void StartScan(ScanSource source)
    {
        StopScan();
        lock (_lifecycleGate)
        {
            if (!_deferredCleanupTask.IsCompleted)
            {
                StatusText = "上一个摄像头仍在后台释放，请稍后重试";
                return;
            }
        }
        Interlocked.Increment(ref _sessionEpoch);
        // 清掉上一次传输残留的分段装配器，避免新一轮扫描读到旧任务的状态文案
        // （分段账本本身落盘持久，段数据由 SegmentAssembler.Open→Resume 恢复，
        // 置空引用不丢段）。注意：_resumeRootId 由构造函数在 StartScan 之前注入，
        // 且本方法下方与 HandleSegmentedTransfer 都依赖它过滤目标传输，不能在此清空。
        _segAssembler = null;
        _completedSegments.Clear();
        SelectedSource = source;
        IsComplete = false;
        IsRecovering = false;
        Progress = 0;
        ReceivedSymbolsText = "0";
        TotalSymbolsText = "0";
        LossRatioText = "0.0%";
        ResetLiveMetrics();
        RecoveryStageText = string.Empty;

        try
        {
            uint zxingAbi = ZxingDecoder.AbiVersion();
            if (zxingAbi != 1)
            {
                throw new InvalidOperationException(
                    $"二维码解码库 ABI 不兼容（期望 1，实际 {zxingAbi}）");
            }
            _session = new ReceiverSession();
            Interlocked.Exchange(ref _recoveryStarted, 0);
            _capture = FrameSourceFactory.Create(source);
            if (!_capture.IsOpen)
            {
                StopScan();
                StatusText = source is DeviceSource
                    ? "无法打开设备，请检查是否被其他程序占用"
                    : $"无法打开视频源: {source.DisplayName}";
                return;
            }

            // The onDecoded callback runs under the pool's IngestLock. Returns true
            // when this symbol completes recovery so the pool stops ingesting.
            _pool = new QrDecodePool((payload, bbox) => OnDecoded(payload, bbox));
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

            IsScanning = true;
            StatusText = _resumeRootId is null
                ? $"正在扫描… 视频源: {source.DisplayName}"
                : $"正在继续任务 {_resumeRootId[..8]}…，其他文件会被忽略";
        }
        catch (Exception ex)
        {
            StopScan();
            StatusText = $"启动设备失败: {ex.Message}";
        }
    }

    [RelayCommand]
    public void StopScan()
    {
        Thread? producer;
        QrDecodePool? pool;
        IFrameSource? capture;
        ReceiverSession? session;
        Task<RecoveryOutcome>? recoveryTask;
        Task cleanup;
        lock (_lifecycleGate)
        {
            _producerRunning = false;
            IsScanning = false;
            Interlocked.Increment(ref _sessionEpoch);

            // A previously detached camera read is still being cleaned up. Do
            // not lose that task or attempt to dispose the same pipeline twice.
            if (_capture is null && _pool is null && _session is null &&
                !_deferredCleanupTask.IsCompleted)
            {
                StatusText = "摄像头响应缓慢，正在后台安全释放…";
                return;
            }
            producer = _producerThread;
            _producerThread = null;
            pool = _pool;
            _pool = null;
            capture = _capture;
            _capture = null;
            session = _session;
            _session = null;
            recoveryTask = _recoveryCoreTask;
            if (producer is null && pool is null && capture is null &&
                session is null && recoveryTask is null)
            {
                cleanup = Task.CompletedTask;
            }
            else
            {
                // Publish the cleanup task while still holding the lifecycle
                // gate. A simultaneous StopScan then observes it and cannot
                // detach/dispose a second copy of this pipeline.
                cleanup = Task.Run(() => CleanupDetachedPipeline(
                    producer, pool, capture, session, recoveryTask));
                _deferredCleanupTask = cleanup;
            }
        }

        if (ReferenceEquals(cleanup, Task.CompletedTask))
        {
            ResetStoppedUi();
            return;
        }

        // Never free a capture, decode pool or Rust session while a producer,
        // native decode, ingest or recovery call may still be using it. Perform
        // the complete ordered teardown as one task. A wedged DirectShow read is
        // quarantined after a short wait so navigation remains responsive; the
        // task retains every resource and disposes them only after the read exits.
        Task completed = Task.WhenAny(cleanup, Task.Delay(TimeSpan.FromSeconds(2)))
            .GetAwaiter().GetResult();
        if (!ReferenceEquals(completed, cleanup))
        {
            _ = cleanup.ContinueWith(t =>
            {
                _ = t.Exception; // Observe a delayed teardown fault.
                lock (_lifecycleGate)
                {
                    if (ReferenceEquals(_deferredCleanupTask, cleanup))
                        _deferredCleanupTask = Task.CompletedTask;
                    if (ReferenceEquals(_recoveryCoreTask, recoveryTask))
                        _recoveryCoreTask = null;
                }
            }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            StatusText = "摄像头响应缓慢，正在后台安全释放…";
            IsRecovering = false;
            return;
        }

        try
        {
            cleanup.GetAwaiter().GetResult();
        }
        finally
        {
            lock (_lifecycleGate)
            {
                if (ReferenceEquals(_deferredCleanupTask, cleanup))
                    _deferredCleanupTask = Task.CompletedTask;
                if (ReferenceEquals(_recoveryCoreTask, recoveryTask))
                    _recoveryCoreTask = null;
            }
        }
        ResetStoppedUi();
    }

    private static void CleanupDetachedPipeline(
        Thread? producer,
        QrDecodePool? pool,
        IFrameSource? capture,
        ReceiverSession? session,
        Task<RecoveryOutcome>? recoveryTask)
    {
        // Producer owns ReadGray/SnapshotBgr. It must exit before capture.Dispose.
        if (producer?.IsAlive == true) producer.Join();

        if (recoveryTask is not null)
        {
            try
            {
                recoveryTask.GetAwaiter().GetResult();
            }
            catch
            {
                // The UI continuation reports recovery errors. Teardown still
                // owns and must release all native/managed resources.
            }
        }

        try
        {
            if (pool is not null)
            {
                pool.RunExclusive(() =>
                {
                    pool.IngestStopped = true;
                    return true;
                });
                pool.Dispose();
            }
        }
        finally
        {
            try
            {
                session?.Dispose();
            }
            finally
            {
                capture?.Dispose();
            }
        }
    }

    private void ResetStoppedUi()
    {
        IsRecovering = false;
        if (!IsComplete)
        {
            Progress = 0;
            ReceivedSymbolsText = "0";
            StatusText = "已停止";
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
        ResetLiveMetrics();
        RecoveryStageText = string.Empty;
        StatusText = "等待扫码…";
    }

    /// <summary>
    /// Producer: perform the only camera read, feed grayscale pixels to the
    /// decode pool, and publish a throttled BGR snapshot for preview.
    /// </summary>
    private void ProducerLoop()
    {
        long previewInterval = Math.Max(1, Stopwatch.Frequency / PreviewFps);
        long nextPreviewAt = 0;
        while (_producerRunning)
        {
            // Snapshot references once per iteration. StopScan may detach the
            // fields while a driver call is blocked, but keeps these objects
            // alive until this producer exits.
            IFrameSource? capture = _capture;
            QrDecodePool? pool = _pool;
            if (capture is null || pool is null) break;
            Mat? gray = capture.ReadGray();
            if (gray is null)
            {
                if (!capture.IsOpen)
                {
                    // Source is gone for good (captured window closed, region
                    // invalid, device died). StopScan joins this producer —
                    // dispatching it synchronously here would self-deadlock.
                    HandleFrameSourceLost();
                    break;
                }
                // Transient miss — a few nulls in a row is normal.
                Thread.Sleep(10);
                continue;
            }
            // Submit clones the pixels; the Mat itself is reused by VideoCapture.
            pool.Submit(gray);

            long now = Stopwatch.GetTimestamp();
            if (now >= nextPreviewAt)
            {
                PreviewFrame? preview = capture.SnapshotBgr();
                if (preview is not null)
                {
                    Action<PreviewFrame>? handler = PreviewFrameReady;
                    if (handler is null)
                    {
                        preview.Dispose();
                        nextPreviewAt = now + previewInterval;
                        continue;
                    }
                    try
                    {
                        // Ownership transfers to the single UI subscriber.
                        handler(preview);
                    }
                    catch
                    {
                        preview.Dispose();
                        // Preview is cosmetic. A subscriber must never kill the
                        // capture/decode producer thread.
                    }
                }
                nextPreviewAt = now + previewInterval;
            }
        }
    }

    /// <summary>
    /// The frame source died mid-scan (captured window closed, screen region
    /// invalid, device unplugged). Runs on the producer thread, so the stop
    /// itself is dispatched — <see cref="StopScan"/> joins the producer and
    /// would otherwise wait on itself. The status message is written after the
    /// stop so <c>ResetStoppedUi</c> cannot overwrite it.
    /// </summary>
    private void HandleFrameSourceLost()
    {
        _ = Task.Run(() =>
        {
            try
            {
                StopScan();
            }
            catch
            {
                // The cleanup path reports its own failures; the message below
                // is the actionable one either way.
            }
            StatusText = "视频源已关闭，扫描已停止";
        });
    }

    /// <summary>
    /// Per-frame ingest callback (runs under <see cref="QrDecodePool.IngestLock"/>).
    /// Returns true when this symbol completes recovery.
    /// </summary>
    private bool OnDecoded(byte[] payload, int[]? unusedBbox)
    {
        QrDecodePool? pool = _pool;
        ReceiverSession? session = _session;
        if (pool is null || pool.IngestStopped || session is null)
        {
            return false;
        }
        // A stored segment may still be on screen while the operator switches to
        // the next one. Never let it initialize the fresh child receiver again.
        if (_completedSegments.Contains(payload))
        {
            return false;
        }
        IngestStatus? status = session.Ingest(payload);
        if (status is null)
        {
            return false;
        }
        IngestStatus s = status.Value;
        int epoch = Volatile.Read(ref _sessionEpoch);

        if (s.Complete)
        {
            if (Interlocked.Exchange(ref _recoveryStarted, 1) == 0)
            {
                // Only UI state is changed on the dispatcher. Native assembly,
                // hashing and disk I/O run on the thread pool.
                System.Windows.Application.Current?.Dispatcher.BeginInvoke(() =>
                {
                    if (epoch != Volatile.Read(ref _sessionEpoch) ||
                        !ReferenceEquals(session, _session) ||
                        !ReferenceEquals(pool, _pool))
                    {
                        return;
                    }
                    IsComplete = true;
                    // Snapshot BOTH the mode and the saver instance at
                    // completion-detection time: an in-flight transfer keeps
                    // the folder that was active when it completed — changing
                    // the folder mid-recovery only affects the next transfer.
                    AirFerry.Windows.Bundle.ContinuousSaver? saver =
                        ContinuousMode ? _continuousSaver : null;
                    _ = RecoverAndStageAsync(session, pool, epoch, saver);
                });
            }
            return true;
        }
        return false;
    }

    /// <summary>
    /// Assemble + verify + stage the recovered bytes. Mirrors Android's
    /// <c>recoverAndStage</c> step by step.
    /// </summary>
    private async Task RecoverAndStageAsync(
        ReceiverSession session, QrDecodePool pool, int epoch,
        AirFerry.Windows.Bundle.ContinuousSaver? saver)
    {
        Task<RecoveryOutcome> coreTask;
        lock (_lifecycleGate)
        {
            if (epoch != Volatile.Read(ref _sessionEpoch) ||
                !ReferenceEquals(session, _session) ||
                !ReferenceEquals(pool, _pool))
            {
                return;
            }
            coreTask = Task.Run(() => RecoverAndStageCore(session, pool, saver));
            _recoveryCoreTask = coreTask;
        }
        IsRecovering = true;
        RecoveryStageText = "正在组装数据…";

        RecoveryOutcome outcome;
        try
        {
            outcome = await coreTask;
        }
        catch (Exception ex)
        {
            bool reset = ResetReceiverAfterRecoveryFailure(session, pool, epoch);
            if (epoch == Volatile.Read(ref _sessionEpoch))
            {
                IsComplete = false;
                IsRecovering = false;
                RecoveryStageText = string.Empty;
                StatusText = reset
                    ? $"当前分段校验失败，可重新扫码: {ex.Message}"
                    : $"恢复失败: {ex.Message}";
            }
            return;
        }
        finally
        {
            lock (_lifecycleGate)
            {
                if (ReferenceEquals(_recoveryCoreTask, coreTask))
                {
                    _recoveryCoreTask = null;
                }
            }
        }

        if (epoch != Volatile.Read(ref _sessionEpoch))
        {
            return;
        }

        IsRecovering = false;
        RecoveryStageText = string.Empty;
        if (outcome.Result is null && outcome.ContinuousReport is null)
        {
            // A large-transfer segment was stored but the transfer is not yet
            // complete — keep scanning for the remaining segments.
            if (_segAssembler is not null)
            {
                IsComplete = false;
                StatusText = _segAssembler.IsComplete()
                    ? "正在合并分段…"
                    : $"分段 {_segAssembler.ReceivedCount()}/{_segAssembler.SegmentCount()} 已收，继续扫描下一段…";
                return;
            }
            IsComplete = false;
            StatusText = _resumeRootId is null
                ? "组装失败"
                : $"等待任务 {_resumeRootId[..8]}… 的分段，其他文件已忽略";
            return;
        }
        if (saver is not null && outcome.ContinuousReport is not null)
        {
            // Continuous mode: record the folder save, re-arm a fresh receiver
            // and keep scanning — no navigation, no teardown.
            RecordContinuousOutcome(saver, outcome.ContinuousReport);
            // A successful or already-deduplicated save must not be received again
            // while the sender keeps looping it. A FAILED save stays eligible so
            // the idempotent archive/retry path can run on the replay.
            bool remember = outcome.ContinuousReport.Status != ContinuousSaveStatus.Failed;
            ContinueNextTransfer(session, pool, epoch, remember);
            return;
        }
        StatusText = "接收完成";
        TransferCompleted?.Invoke(outcome.Result!);
    }

    private RecoveryOutcome RecoverAndStageCore(
        ReceiverSession session, QrDecodePool pool,
        AirFerry.Windows.Bundle.ContinuousSaver? saver)
    {
        pool.IngestStopped = true;

        // descriptor-v5 large transfer: store this segment into the disk-backed
        // assembler and return once every segment has arrived.
        if (pool.RunExclusive(() => session.IsSegmented()))
        {
            return HandleSegmentedTransfer(session, pool, saver);
        }
        if (_resumeRootId is not null)
        {
            SwapReceiverForNextSegment(session, pool);
            return RecoveryOutcome.None();
        }

        // Take one coherent native snapshot under the ingest lock. No metadata
        // getter is allowed to outlive or race disposal of the native handle.
        AssembledPayload? payload = pool.RunExclusive<AssembledPayload?>(() =>
        {
            byte[]? bytes = session.Assemble();
            return bytes is null || bytes.Length == 0
                ? null
                : new AssembledPayload(
                    bytes,
                    session.Crc32(),
                    session.Crc32Known(),
                    session.FileName(),
                    session.FileSize());
        });
        if (payload is null)
        {
            SwapReceiverForNextSegment(session, pool);
            return RecoveryOutcome.None();
        }

        ulong receivedCrc = Crc32.Compute(payload.Bytes);
        ClassifiedPayload classified = ClassifyRecovered(
            payload.Bytes, payload.DisplayName, payload.OriginalSize);
        if (saver is not null)
        {
            return RecoveryOutcome.Continuous(TrySaveContinuous(saver, classified));
        }
        return RecoveryOutcome.Single(StageClassified(
            classified, payload.ExpectedCrc, payload.CrcKnown, receivedCrc));
    }

    private enum RecoveredKind { EtText, Bundle, TextLikeFile, SingleFile }

    private sealed record ClassifiedPayload(
        RecoveredKind Kind,
        string DisplayName,
        ulong OriginalSize,
        byte[] Bytes,
        string? Text,
        IReadOnlyList<BundleFile>? BundleFiles);

    /// <summary>Recovery pipeline outcome: a staged store result, or a
    /// continuous-folder save report, or neither (a segment was stored — keep
    /// scanning for the rest of the transfer).</summary>
    private sealed record RecoveryOutcome(RecoveryResult? Result, ContinuousSaveReport? ContinuousReport)
    {
        public static RecoveryOutcome None() => new(null, null);
        public static RecoveryOutcome Single(RecoveryResult result) => new(result, null);
        public static RecoveryOutcome Continuous(ContinuousSaveReport report) => new(null, report);
    }

    /// <summary>
    /// Classify assembled bytes into one of the four recovery shapes. Shared
    /// by the plain and segmented paths so the two cascades cannot drift; the
    /// mutating steps (ETTEXT magic strip, .txt name normalization) are
    /// applied here, once.
    /// </summary>
    private static ClassifiedPayload ClassifyRecovered(
        byte[] bytes, string displayName, ulong originalSize)
    {
        if (TextParser.IsText(bytes))
        {
            // ETTEXTv1 payloads start with the 8-byte wire magic. Strip it up
            // front so EVERY downstream path — the text UI, the continuous
            // folder save and the oversized→file fallback alike — sees the
            // message text, never the protocol header (the fallback used to
            // stage a file that literally began with the "ETTEXTv1" bytes).
            // Checked BEFORE the bundle branch: the two magics never collide
            // ("ETTEXTv1" vs "ETBUNDL1").
            bytes = bytes[TextParser.Magic.Length..];
            originalSize = (ulong)bytes.LongLength;
            if (string.IsNullOrEmpty(displayName) || !displayName.Contains('.'))
            {
                displayName = string.IsNullOrEmpty(displayName)
                    ? "文字消息.txt"
                    : displayName + ".txt";
            }
            // Text UI when it fits the cap; oversized or invalid-UTF-8 text →
            // an ordinary .txt file.
            return FileNameUtil.DecodeUtf8Strict(bytes) is { } text
                ? new ClassifiedPayload(RecoveredKind.EtText, displayName, originalSize, bytes, text, null)
                : new ClassifiedPayload(RecoveredKind.SingleFile, displayName, originalSize, bytes, null, null);
        }
        if (BundleParser.IsBundle(bytes))
        {
            AirFerry.Windows.Bundle.Bundle? bundle = BundleParser.Parse(bytes);
            // Parse failure falls through to single-file handling with the
            // container bytes (same fallback the bundle branch always had).
            return bundle is not null && bundle.Files.Count > 0
                ? new ClassifiedPayload(RecoveredKind.Bundle, displayName, originalSize, bytes, null, bundle.Files)
                : new ClassifiedPayload(RecoveredKind.SingleFile, displayName, originalSize, bytes, null, null);
        }
        if (FileNameUtil.IsTextLikeName(
                string.IsNullOrEmpty(displayName) ? "received_file" : displayName)
            && FileNameUtil.FitsTextUi(bytes.LongLength))
        {
            // Single text-like document (readme.md, notes.json, …): the
            // copy/share UI only when the payload is valid UTF-8 and small
            // enough; otherwise an ordinary file.
            return FileNameUtil.DecodeUtf8Strict(bytes) is { } text
                ? new ClassifiedPayload(RecoveredKind.TextLikeFile, displayName, originalSize, bytes, text, null)
                : new ClassifiedPayload(RecoveredKind.SingleFile, displayName, originalSize, bytes, null, null);
        }
        return new ClassifiedPayload(RecoveredKind.SingleFile, displayName, originalSize, bytes, null, null);
    }

    /// <summary>Stage a classified payload into the ContentStore (single-receive mode).</summary>
    private RecoveryResult StageClassified(
        ClassifiedPayload c, ulong expectedCrc, bool crcKnown, ulong receivedCrc)
    {
        return c.Kind switch
        {
            RecoveredKind.EtText =>
                StageEtText(c.Text!, c.DisplayName, expectedCrc, crcKnown, receivedCrc),
            RecoveredKind.Bundle =>
                StageBundle(c.BundleFiles!, expectedCrc, crcKnown, receivedCrc)
                ?? StageSingleFile(c.Bytes, c.DisplayName, c.OriginalSize,
                    expectedCrc, crcKnown, receivedCrc),
            RecoveredKind.TextLikeFile =>
                StageTextLikeFile(c.Bytes, c.DisplayName, c.OriginalSize,
                    expectedCrc, crcKnown, receivedCrc, c.Text!),
            _ => StageSingleFile(c.Bytes, c.DisplayName, c.OriginalSize,
                expectedCrc, crcKnown, receivedCrc),
        };
    }

    /// <summary>
    /// Save a classified payload into the continuous folder snapshot taken at
    /// completion time. Disk failures become Failed reports — the pipeline
    /// keeps scanning either way.
    /// </summary>
    private ContinuousSaveReport TrySaveContinuous(
        AirFerry.Windows.Bundle.ContinuousSaver saver, ClassifiedPayload c)
    {
        try
        {
            return c.Kind switch
            {
                RecoveredKind.EtText => saver.SaveText(c.DisplayName, c.Text!),
                RecoveredKind.Bundle => saver.SaveBundle(c.BundleFiles!, null),
                // Text-like files are real files first: save the original
                // bytes, not a text re-encode.
                _ => saver.SaveSingle(c.DisplayName, c.Bytes),
            };
        }
        catch (Exception ex)
        {
            return ContinuousSaveReport.Failed(c.DisplayName, ex.Message);
        }
    }

    /// <summary>
    /// Move an already-verified decompressed file (&gt;256 MiB segmented path)
    /// into the continuous folder, deduplicating by the root SHA-256 the
    /// native decompression already verified.
    /// </summary>
    private ContinuousSaveReport TryMoveContinuous(
        AirFerry.Windows.Bundle.ContinuousSaver saver,
        string displayName, string sourcePath, string sha256Hex)
    {
        try
        {
            return saver.MoveVerifiedFile(displayName, sourcePath, sha256Hex);
        }
        catch (Exception ex)
        {
            return ContinuousSaveReport.Failed(displayName, ex.Message);
        }
    }

    /// <summary>
    /// Store one recovered descriptor-v5 segment into the disk-backed assembler.
    /// Returns a completed outcome only once every segment of the root
    /// transfer has arrived and been merged; otherwise None (the receiver keeps
    /// scanning for the next segment).
    /// </summary>
    private RecoveryOutcome HandleSegmentedTransfer(
        ReceiverSession session, QrDecodePool pool,
        AirFerry.Windows.Bundle.ContinuousSaver? saver)
    {
        // Take a coherent native snapshot under the ingest lock: metadata +
        // assembled **compressed** bytes for this segment (no decompression —
        // the whole compressed stream is decompressed once at archive time).
        SegmentPayload? seg = pool.RunExclusive<SegmentPayload?>(() =>
        {
            byte[]? bytes = session.AssembleRaw();
            if (bytes is null || bytes.Length == 0) return null;
            return new SegmentPayload(
                bytes,
                session.SegmentIndex(),
                session.SegmentCount(),
                session.RootOriginalSize(),
                session.RootSessionIdLo(),
                session.RootSessionIdHi(),
                session.FileName(),
                session.CompressedSize(),
                session.OriginalOffset(),
                session.RawSha256(),
                session.RootSha256(),
                session.Crc32(),
                session.Crc32Known(),
                session.Compression(),
                session.OriginalSize());
        });
        if (seg is null)
        {
            SwapReceiverForNextSegment(session, pool);
            return RecoveryOutcome.None();
        }

        int index = (int)seg.SegmentIndex;
        int count = (int)seg.SegmentCount;
        ulong rootSize = seg.RootOriginalSize; // whole **compressed** stream size
        ulong lo = seg.RootLo;
        ulong hi = seg.RootHi;
        string rootId = $"{hi:x16}{lo:x16}";
        string displayName = string.IsNullOrEmpty(seg.FileName) ? "received_file" : seg.FileName;
        ulong decompressedSize = seg.DecompressedSize;

        byte[] segBytes = seg.Bytes;
        if (count is <= 0 or > AirFerry.Windows.Bundle.SegmentAssembler.MaxSegmentCount)
            throw new InvalidDataException("分段数量超出安全上限");
        if (rootSize == 0 || rootSize > (ulong)long.MaxValue)
            throw new InvalidDataException("压缩流大小无效");
        if (index < 0 || index >= count ||
            seg.OriginalOffset != checked((ulong)index *
                (ulong)AirFerry.Windows.Bundle.SegmentAssembler.SegmentRawBytes))
            throw new InvalidDataException("分段索引或偏移无效");
        ulong expectedCount = checked((rootSize - 1) /
            (ulong)AirFerry.Windows.Bundle.SegmentAssembler.SegmentRawBytes + 1);
        if ((ulong)count != expectedCount)
            throw new InvalidDataException("分段数量与压缩流大小不一致");
        ulong expectedLength = Math.Min(
            (ulong)AirFerry.Windows.Bundle.SegmentAssembler.SegmentRawBytes,
            rootSize - seg.OriginalOffset);
        if (seg.OriginalSize == 0 || seg.OriginalSize != expectedLength ||
            seg.OriginalSize != (ulong)segBytes.LongLength)
            throw new InvalidDataException("分段实际长度与描述符不一致");
        if (seg.RawSha256.Length != 32)
            throw new InvalidDataException("分段描述符缺少 SHA-256");
        if (seg.RootSha256.Length != 32)
            throw new InvalidDataException("分段描述符缺少整文件 SHA-256");
        if (decompressedSize == 0 || decompressedSize > (ulong)long.MaxValue)
            throw new InvalidDataException("原始文件大小无效");
        if (_resumeRootId is not null &&
            !string.Equals(rootId, _resumeRootId, StringComparison.Ordinal))
        {
            SwapReceiverForNextSegment(session, pool);
            return RecoveryOutcome.None();
        }

        // Reuse the active root so a long, sequential transfer does not reopen
        // the ledger and re-hash every earlier ~32 MiB segment for each child.
        // Interleaved roots still open their own identity-bound assembler.
        var asm = _segAssembler is not null
                  && _segAssembler.Matches(
                      lo, hi, count, (long)rootSize, seg.RootSha256, displayName)
            ? _segAssembler
            : AirFerry.Windows.Bundle.SegmentAssembler.Open(
                lo, hi, count, (long)rootSize, (long)decompressedSize,
                seg.Compression, (uint)seg.ExpectedCrc, seg.CrcKnown,
                seg.RootSha256, displayName);
        _segAssembler = asm;

        // Crash recovery: all segments may already be durable while history
        // promotion was interrupted. Promotion is deliberately idempotent.
        if (asm.IsComplete())
            return ArchiveSegmentedTransfer(asm, displayName, decompressedSize, saver);

        // A failure leaves all earlier verified segments untouched. The outer
        // recovery boundary swaps in a fresh child receiver so this segment can
        // be scanned again immediately.
        bool stored = asm.StoreSegment(index, segBytes, seg.RawSha256);
        if (!stored)
        {
            // Already durable (a replayed segment): remember it so the fresh
            // receiver skips the replay instead of receiving it again.
            UpdateSegmentedProgress(asm);
            SwapReceiverForNextSegment(session, pool, rememberCompleted: true);
            return RecoveryOutcome.None();
        }

        if (!asm.IsComplete())
        {
            UpdateSegmentedProgress(asm);
            SwapReceiverForNextSegment(session, pool, rememberCompleted: true);
            return RecoveryOutcome.None();
        }

        return ArchiveSegmentedTransfer(asm, displayName, decompressedSize, saver);
    }

    private RecoveryOutcome ArchiveSegmentedTransfer(
        AirFerry.Windows.Bundle.SegmentAssembler asm,
        string displayName,
        ulong decompressedSize,
        AirFerry.Windows.Bundle.ContinuousSaver? saver)
    {
        // Concatenate the compressed segments and stream-decompress exactly once
        // to a temp file. The native call already verified the decompressed
        // length + CRC32 (when known) + root SHA-256 over the decompressed bytes.
        string decompressedPath = asm.Finish()
            ?? throw new InvalidDataException(
                "分段账本已完成，但解压或完整性校验失败");
        ulong expectedCrc = asm.Crc32();
        bool crcKnown = asm.Crc32Known();

        RecoveryOutcome outcome;
        long length = new FileInfo(decompressedPath).Length;
        // Text / bundle detection needs the bytes in memory. Anything larger
        // than the legacy whole-transfer ceiling is a single file by
        // construction, so skip the in-memory dispatch — ≤256 MiB goes through
        // the shared classifier, larger files stream straight to their sink
        // (ContentStore blob or continuous folder). This is what lets
        // > 256 MiB files be recovered.
        if (length <= 256L * 1024 * 1024)
        {
            byte[] original = File.ReadAllBytes(decompressedPath);
            ulong receivedCrc = Crc32.Compute(original);
            ClassifiedPayload classified = ClassifyRecovered(
                original, displayName, (ulong)original.LongLength);
            outcome = saver is not null
                ? RecoveryOutcome.Continuous(TrySaveContinuous(saver, classified))
                : RecoveryOutcome.Single(StageClassified(
                    classified, expectedCrc, crcKnown, receivedCrc));
        }
        else
        {
            string finalName = string.IsNullOrEmpty(displayName) ? "received_file" : displayName;
            if (saver is not null)
            {
                // Move the verified temp file straight into the continuous
                // folder; on a duplicate the ledger's own directory cleanup
                // (CommitArchived below) removes it.
                outcome = RecoveryOutcome.Continuous(
                    TryMoveContinuous(saver, finalName, decompressedPath, asm.RootSha256Hex));
            }
            else
            {
                // Very large single file: stream/atomically-move the decompressed
                // temp file into ContentStore without holding it in memory.
                // 注意：expectedSize 校验的是**解压产物**长度，必须传解压后大小
                // （调用方的压缩流 rootSize 只用于分段账本，语义勿混——Android 同名
                // 函数的误导性参数名正是当初移植出错的根源）。
                ContentStore.PutResult put = ContentStore.PutFile(
                    finalName, decompressedPath,
                    crcHex: crcKnown ? expectedCrc.ToString("x") : "unknown",
                    crcUnknown: !crcKnown, kind: "file",
                    expectedSha256Hex: asm.RootSha256Hex,
                    expectedSize: (long)decompressedSize,
                    // 稳定条目 ID：入库后若索引发布被中断（崩溃/断电），重试时按
                    // 同 ID 去重，不产生重复历史条目（镜像 Android ScanActivity）。
                    stableEntryId: "segment-" + asm.RootSessionIdHex);
                outcome = RecoveryOutcome.Single(new RecoveryResult(
                    SingleFilePath: put.Path,
                    SingleFileSize: decompressedSize,
                    ExpectedCrc32: crcKnown ? expectedCrc : null,
                    Crc32Known: crcKnown,
                    ReceivedCrc32: null,
                    Bundle: null,
                    BundleDir: null,
                    DisplayName: finalName));
            }
        }

        // A FAILED continuous save (disk full, folder removed, permissions)
        // must NOT commit the ledger: CommitArchived deletes the received
        // segments, the decompressed temp and the resume record — with them
        // gone the transfer could never be retried. Keep everything; the
        // idempotent promotion path (asm.IsComplete() above) retries on the
        // next replayed stream or via the history page's 继续恢复.
        if (outcome.ContinuousReport is { Status: ContinuousSaveStatus.Failed })
        {
            return outcome;
        }

        asm.CommitArchived();
        _segAssembler = null;
        _resumeRootId = null;
        return outcome;
    }

    private sealed record SegmentPayload(
        byte[] Bytes,
        uint SegmentIndex,
        uint SegmentCount,
        ulong RootOriginalSize,
        ulong RootLo,
        ulong RootHi,
        string FileName,
        ulong OriginalSize,
        ulong OriginalOffset,
        byte[] RawSha256,
        byte[] RootSha256,
        ulong ExpectedCrc,
        bool CrcKnown,
        byte Compression,
        ulong DecompressedSize);

    private void UpdateSegmentedProgress(AirFerry.Windows.Bundle.SegmentAssembler asm)
    {
        StatusText = $"分段 {asm.ReceivedCount()}/{asm.SegmentCount()} 已收，继续扫描下一段…";
    }

    /// <summary>Swap to a fresh receiver for the next segment.</summary>
    /// <param name="rememberCompleted">
    /// Record the outgoing child session as stored, so its replayed frames are
    /// dropped by <see cref="OnDecoded"/> instead of re-initializing the new
    /// receiver.
    /// </param>
    private void SwapReceiverForNextSegment(
        ReceiverSession session, QrDecodePool pool, bool rememberCompleted = false)
    {
        lock (_lifecycleGate)
        {
            if (!ReferenceEquals(session, _session) || !ReferenceEquals(pool, _pool))
                return;
            pool.RunExclusive<bool>(() =>
            {
                if (rememberCompleted)
                {
                    _completedSegments.Add(session.SessionId());
                }
                session.Destroy();
                _session = new ReceiverSession();
                Interlocked.Exchange(ref _recoveryStarted, 0);
                pool.IngestStopped = false;
                return true;
            });
        }
    }

    private bool ResetReceiverAfterRecoveryFailure(
        ReceiverSession session, QrDecodePool pool, int epoch)
    {
        lock (_lifecycleGate)
        {
            if (epoch != Volatile.Read(ref _sessionEpoch) ||
                !ReferenceEquals(session, _session) ||
                !ReferenceEquals(pool, _pool))
                return false;
            pool.RunExclusive<bool>(() =>
            {
                session.Destroy();
                _session = new ReceiverSession();
                Interlocked.Exchange(ref _recoveryStarted, 0);
                pool.IngestStopped = false;
                return true;
            });
            return true;
        }
    }

    /// <summary>
    /// Update the continuous counters/feed/status (dispatcher thread). The
    /// counters and feed describe the **currently selected** folder: when the
    /// folder was switched mid-transfer (the save went to the snapshot saver's
    /// older folder), only the status line reports it.
    /// </summary>
    private void RecordContinuousOutcome(
        AirFerry.Windows.Bundle.ContinuousSaver saver, ContinuousSaveReport report)
    {
        switch (report.Status)
        {
            case ContinuousSaveStatus.SkippedDuplicate:
                StatusText = ReferenceEquals(saver, _continuousSaver)
                    ? $"重复，已跳过: {report.DisplayName}"
                    : $"重复，已跳过: {report.DisplayName}（{saver.TargetDir}）";
                break;
            case ContinuousSaveStatus.Failed:
                StatusText = $"保存失败: {report.Error}（继续接收中）";
                break;
            default:
                StatusText = ReferenceEquals(saver, _continuousSaver)
                    ? $"已保存: {report.DisplayName}"
                    : $"已保存: {report.DisplayName}（{saver.TargetDir}）";
                break;
        }
        if (!ReferenceEquals(saver, _continuousSaver))
        {
            return;
        }
        ContinuousItemStatus status;
        string? error = null;
        switch (report.Status)
        {
            case ContinuousSaveStatus.SkippedDuplicate:
                ContinuousSkippedCount++;
                status = ContinuousItemStatus.Skipped;
                break;
            case ContinuousSaveStatus.Failed:
                status = ContinuousItemStatus.Failed;
                error = report.Error;
                break;
            default:
                ContinuousSavedCount++;
                status = ContinuousItemStatus.Saved;
                break;
        }
        ContinuousItems.Insert(0, new ContinuousReceivedItem(
            DateTime.Now.ToString("HH:mm:ss"),
            report.DisplayName,
            report.SizeBytes > 0 ? FormatBytes((ulong)report.SizeBytes) : string.Empty,
            status,
            error));
        while (ContinuousItems.Count > 50)
        {
            ContinuousItems.RemoveAt(ContinuousItems.Count - 1);
        }
    }

    /// <summary>
    /// Continuous mode's "receive the next file" step: re-arm a fresh receiver
    /// (the exact swap the segmented path performs between segments — the
    /// producer thread, decode pool and capture device keep running) and reset
    /// the per-transfer UI so the next descriptor starts from zero.
    /// </summary>
    private void ContinueNextTransfer(
        ReceiverSession session, QrDecodePool pool, int epoch, bool rememberCompleted = false)
    {
        IsComplete = false;
        Progress = 0;
        ReceivedSymbolsText = "0";
        TotalSymbolsText = "0";
        FileSummaryText = "等待下一份文件…";
        _rateSamples.Clear();
        _transferStartTimestamp = 0;
        _decodePerSecond = 0;
        _recentWireBytesPerSecond = 0;
        SwapReceiverForNextSegment(session, pool, rememberCompleted);
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
            BundleDir: null,
            DisplayName: finalName);
    }

    /// <summary>
    /// Stage a pure ETTEXTv1 message: store UTF-8 body under the descriptor
    /// filename (user-chosen on sender; default "文字消息.txt").
    /// </summary>
    private RecoveryResult StageEtText(string text, string displayName,
        ulong expectedCrc, bool crcKnown, ulong receivedCrc)
    {
        // Store the UTF-8 body (without magic), while retaining transport CRC
        // fields so corruption is not hidden by recomputing a different hash.
        string finalName = string.IsNullOrEmpty(displayName)
            ? "文字消息.txt"
            : (displayName.Contains('.') ? displayName : displayName + ".txt");
        byte[] contentBytes = Encoding.UTF8.GetBytes(text);
        ulong contentCrc = Crc32.Compute(contentBytes);
        string crcHex = contentCrc.ToString("x");
        ContentStore.PutResult put = ContentStore.PutBytes(
            finalName, contentBytes, crcHex, crcUnknown: false, kind: "text");
        return new RecoveryResult(
            SingleFilePath: put.Path,
            SingleFileSize: (ulong)contentBytes.Length,
            ExpectedCrc32: expectedCrc,
            Crc32Known: crcKnown,
            ReceivedCrc32: receivedCrc,
            Bundle: null,
            BundleDir: null,
            Text: text,
            DisplayName: finalName);
    }

    /// <summary>
    /// Stage a text-like single file into ContentStore and keep text for the copy UI.
    /// </summary>
    private RecoveryResult StageTextLikeFile(byte[] bytes, string displayName,
        ulong originalSize, ulong expectedCrc, bool crcKnown, ulong receivedCrc, string text)
    {
        string finalName = string.IsNullOrEmpty(displayName) ? "文字消息.txt" : displayName;
        ContentStore.PutResult put = ContentStore.PutBytes(
            finalName, bytes,
            crcHex: crcKnown ? expectedCrc.ToString("x") : "unknown",
            crcUnknown: !crcKnown, kind: "text");
        return new RecoveryResult(
            SingleFilePath: put.Path,
            SingleFileSize: originalSize > 0 ? originalSize : (ulong)bytes.Length,
            ExpectedCrc32: expectedCrc,
            Crc32Known: crcKnown,
            ReceivedCrc32: receivedCrc,
            Bundle: null,
            BundleDir: null,
            Text: text,
            DisplayName: finalName);
    }

    private RecoveryResult? StageBundle(
        IReadOnlyList<BundleFile> files, ulong expectedCrc, bool crcKnown, ulong receivedCrc)
    {
        if (files.Count == 0)
        {
            return null;
        }
        string bundleId = Guid.NewGuid().ToString("N");
        string bundleTitle = $"发送_{DateTime.Now:MMdd_HHmmss}";
        ContentStore.PutBytesBatch(files.Select(f =>
            new ContentStore.PutBytesRequest(
                f.Name, f.Data, Kind: "file",
                BundleId: bundleId, BundleTitle: bundleTitle)).ToList());
        return new RecoveryResult(
            SingleFilePath: null,
            SingleFileSize: null,
            ExpectedCrc32: expectedCrc,
            Crc32Known: crcKnown,
            ReceivedCrc32: receivedCrc,
            // Keep in-memory bytes for the bundle UI; disk is content-addressed.
            Bundle: files.Select(f => new BundleFile(f.Name, f.Data)).ToList(),
            BundleDir: null);
    }

    /// <summary>
    /// Periodically poll progress for the live UI (called by a timer at ~7 Hz).
    /// Keeps the hot ingest path allocation-free.
    /// </summary>
    public void RefreshProgress()
    {
        QrDecodePool? pool = _pool;
        ReceiverSession? session = _session;
        long now = Stopwatch.GetTimestamp();
        if (pool is not null)
        {
            ScanMetricsText = $"采集 {pool.CapturedFrames} 帧 · " +
                $"丢弃 {pool.DroppedFrames} 帧 · 解码 {pool.DecodedSymbols} 码";
        }
        if (pool is null || session is null)
        {
            return;
        }

        LiveSnapshot live = pool.RunExclusive(() =>
        {
            if (!session.IsInitialized)
            {
                return new LiveSnapshot(null, string.Empty, 0, 0, 0);
            }
            return new LiveSnapshot(
                session.Progress(),
                session.FileName(),
                session.FileSize(),
                session.SymbolSizeBytes,
                session.EstimatedTotalSymbols);
        });
        if (live.Progress is null)
        {
            return;
        }
        ProgressSnapshot p = live.Progress.Value;
        UpdateRates(now, pool.DecodedSymbols, p.ReceivedSymbols, live.SymbolSize, p.Complete);
        UpdateFileSummary(live, p);

        if (p.TotalSymbols > 0)
        {
            if (_transferStartTimestamp == 0)
            {
                _transferStartTimestamp = now;
            }
            Progress = p.Complete
                ? 100
                : Math.Clamp(p.ReceivedSymbols * 100.0 / p.TotalSymbols, 0, 100);
            TotalSymbolsText = p.TotalSymbols.ToString();
        }
        else if (p.ReceivedSymbols > 0)
        {
            Progress = live.EstimatedTotalSymbols > 0
                ? Math.Clamp(p.ReceivedSymbols * 100.0 / live.EstimatedTotalSymbols, 0, 15)
                : 0;
        }
        ReceivedSymbolsText = p.ReceivedSymbols.ToString();
        LossRatioText = $"{p.LossRatio * 100:F1}%";

        if (!IsRecovering)
        {
            StatusText = p.Complete
                ? "✓ 文件恢复完成"
                : !p.MetaConfirmed && p.ReceivedSymbols > 0
                    ? $"正在同步…已缓存 {p.ReceivedSymbols} 个符号"
                    : p.TotalSymbols == 0
                        ? "等待二维码…"
                        : p.ReceivedSymbols > 0 && p.DecodedBlocks == 0
                            ? $"接收中… {p.ReceivedSymbols}/{p.TotalSymbols}（等待解码）"
                            : $"恢复中… {Progress:F0}%";
        }
    }

    private void UpdateRates(long now, long decoded, long received, uint symbolSize, bool complete)
    {
        if (complete)
        {
            _rateSamples.Clear();
            _decodePerSecond = 0;
            _recentWireBytesPerSecond = 0;
        }
        else if (decoded > 0 || received > 0)
        {
            _rateSamples.Enqueue(new RateSample(now, decoded, received));
            long cutoff = now - Stopwatch.Frequency * RateWindowSeconds;
            while (_rateSamples.Count > 1 && _rateSamples.Peek().Timestamp < cutoff)
            {
                _rateSamples.Dequeue();
            }
            if (_rateSamples.Count >= 2)
            {
                RateSample oldest = _rateSamples.Peek();
                RateSample newest = _rateSamples.Last();
                long elapsedTicks = newest.Timestamp - oldest.Timestamp;
                if (elapsedTicks >= Stopwatch.Frequency * RateMinMilliseconds / 1000)
                {
                    long decodedDelta = Math.Max(0, newest.DecodedSymbols - oldest.DecodedSymbols);
                    long receivedDelta = Math.Max(0, newest.ReceivedSymbols - oldest.ReceivedSymbols);
                    _decodePerSecond = (long)Math.Min(long.MaxValue,
                        decodedDelta * (double)Stopwatch.Frequency / elapsedTicks);
                    _recentWireBytesPerSecond = (long)Math.Min(long.MaxValue,
                        receivedDelta * (double)symbolSize * Stopwatch.Frequency / elapsedTicks);
                }
            }
        }

        TimeSpan elapsed = _transferStartTimestamp == 0
            ? TimeSpan.Zero
            : TimeSpan.FromSeconds((now - _transferStartTimestamp) /
                (double)Stopwatch.Frequency);
        TransferMetricsText = $"解码 {_decodePerSecond} 符号/秒 · " +
            $"有效 {FormatBytes((ulong)Math.Max(0, _recentWireBytesPerSecond))}/s · " +
            $"用时 {FormatDuration(elapsed)}";
    }

    private void UpdateFileSummary(LiveSnapshot live, ProgressSnapshot progress)
    {
        if (string.IsNullOrWhiteSpace(live.FileName))
        {
            FileSummaryText = "等待描述符…";
            return;
        }
        string original = live.FileSize > 0 ? FormatBytes(live.FileSize) : "大小未知";
        ulong wireBytes = progress.TotalSymbols > 0
            ? (ulong)progress.TotalSymbols * live.SymbolSize
            : 0;
        FileSummaryText = wireBytes > 0
            ? $"{live.FileName} · {original} → 传输 {FormatBytes(wireBytes)}"
            : $"{live.FileName} · {original}";
    }

    private void ResetLiveMetrics()
    {
        ScanMetricsText = "采集 0 帧 · 丢弃 0 帧 · 解码 0 码";
        FileSummaryText = "等待描述符…";
        TransferMetricsText = "解码 0 符号/秒 · 有效 0 B/s · 用时 00:00";
        _rateSamples.Clear();
        _transferStartTimestamp = 0;
        _decodePerSecond = 0;
        _recentWireBytesPerSecond = 0;
    }

    private static string FormatBytes(ulong bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        double value = bytes;
        int unit = 0;
        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }
        return unit == 0 ? $"{bytes} B" : $"{value:F1} {units[unit]}";
    }

    private static string FormatDuration(TimeSpan elapsed) => elapsed.TotalHours >= 1
        ? $"{(int)elapsed.TotalHours:D2}:{elapsed.Minutes:D2}:{elapsed.Seconds:D2}"
        : $"{elapsed.Minutes:D2}:{elapsed.Seconds:D2}";

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
