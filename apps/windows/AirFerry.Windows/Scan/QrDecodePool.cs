using System.Buffers;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using OpenCvSharp;

namespace AirFerry.Windows.Scan;

/// <summary>
/// Bounded, parallel QR decode pipeline. It mirrors Android's implementation:
/// pooled luminance frames, 2–6 workers, multi-code bbox tracking, native
/// ZXing-C++ region decodes, periodic full-frame re-lock, batched serialized
/// ingest, and drop-newest backpressure.
/// </summary>
public sealed class QrDecodePool : IDisposable
{
    public int WorkerCount { get; } = Math.Clamp(Environment.ProcessorCount - 3, 2, 6);

    private const int IngestBatch = 4;
    private const int MultiFullDecodeEvery = 3;
    private const float TrackMargin = 0.35F;

    private readonly BlockingCollection<GrayFrame> _queue;
    private readonly List<Thread> _workers = [];
    private readonly CancellationTokenSource _cts = new();
    private readonly Func<byte[], int[]?, bool> _onDecoded;
    private readonly object _trackingGate = new();
    private volatile bool _running;
    private int _disposed;

    private long _capturedFrames;
    private long _droppedFrames;
    private long _decodedSymbols;
    private long _multiMisses;
    private int[]? _multiTrackedBboxes;
    private int _multiLockedCount;

    internal volatile bool IngestStopped;
    internal readonly object IngestLock = new();

    private sealed class GrayFrame : IDisposable
    {
        private byte[]? _pixels;

        internal GrayFrame(byte[] pixels, int length, int width, int height, int rowStride)
        {
            _pixels = pixels;
            Length = length;
            Width = width;
            Height = height;
            RowStride = rowStride;
        }

        internal byte[] Pixels => Volatile.Read(ref _pixels) ??
            throw new ObjectDisposedException(nameof(GrayFrame));
        internal int Length { get; }
        internal int Width { get; }
        internal int Height { get; }
        internal int RowStride { get; }

        public void Dispose()
        {
            byte[]? pixels = Interlocked.Exchange(ref _pixels, null);
            if (pixels is not null)
            {
                ArrayPool<byte>.Shared.Return(pixels);
            }
        }
    }

    private readonly record struct PendingSymbol(byte[] Payload, int[] Bbox);

    public long CapturedFrames => Interlocked.Read(ref _capturedFrames);
    public long DroppedFrames => Interlocked.Read(ref _droppedFrames);
    public long DecodedSymbols => Interlocked.Read(ref _decodedSymbols);

    public QrDecodePool(Func<byte[], int[]?, bool> onDecoded)
    {
        _onDecoded = onDecoded;
        _queue = new BlockingCollection<GrayFrame>(WorkerCount + 2);
    }

    public void Start()
    {
        if (_running)
        {
            return;
        }
        _running = true;
        for (int index = 0; index < WorkerCount; index++)
        {
            var worker = new Thread(() => WorkerLoop(_cts.Token))
            {
                IsBackground = true,
                Name = $"qr-decode-{index}",
            };
            _workers.Add(worker);
            worker.Start();
        }
    }

    /// <summary>
    /// Copy a reusable OpenCV Gray Mat into one pooled compact luminance buffer.
    /// The native decoder reads this buffer in place; there is no second managed
    /// frame allocation in the worker.
    /// </summary>
    public bool Submit(Mat gray)
    {
        if (!_running || Volatile.Read(ref _disposed) != 0 || gray.Empty() ||
            gray.Type() != MatType.CV_8UC1 || gray.Width <= 0 || gray.Height <= 0)
        {
            return false;
        }

        Interlocked.Increment(ref _capturedFrames);
        int width = gray.Width;
        int height = gray.Height;
        int rowStride = width;
        int length = checked(rowStride * height);
        int sourceStride = checked((int)gray.Step());
        if (sourceStride < width)
        {
            Interlocked.Increment(ref _droppedFrames);
            return false;
        }

        byte[] pixels = ArrayPool<byte>.Shared.Rent(length);
        try
        {
            if (sourceStride == rowStride)
            {
                Marshal.Copy(gray.Data, pixels, 0, length);
            }
            else
            {
                for (int y = 0; y < height; y++)
                {
                    Marshal.Copy(IntPtr.Add(gray.Data, checked(y * sourceStride)),
                        pixels, checked(y * rowStride), width);
                }
            }
        }
        catch
        {
            ArrayPool<byte>.Shared.Return(pixels);
            throw;
        }

        var frame = new GrayFrame(pixels, length, width, height, rowStride);
        try
        {
            if (_queue.TryAdd(frame, 0))
            {
                return true;
            }
        }
        catch (InvalidOperationException)
        {
            // CompleteAdding raced this submit during shutdown.
        }
        Interlocked.Increment(ref _droppedFrames);
        frame.Dispose();
        return false;
    }

    private void WorkerLoop(CancellationToken cancellationToken)
    {
        var pending = new List<PendingSymbol>(IngestBatch);
        while (_running && !cancellationToken.IsCancellationRequested)
        {
            GrayFrame? frame;
            try
            {
                if (!_queue.TryTake(out frame, 200, cancellationToken))
                {
                    continue;
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }

            try
            {
                List<ZxingDecoder.MultiResult> decoded = DecodeMultiTracked(frame);
                if (decoded.Count > 0)
                {
                    Interlocked.Add(ref _decodedSymbols, decoded.Count);
                    foreach (ZxingDecoder.MultiResult result in decoded)
                    {
                        pending.Add(new PendingSymbol(result.Payload, result.Bbox));
                    }
                }
                if (pending.Count >= IngestBatch ||
                    (pending.Count > 0 && _queue.Count == 0))
                {
                    FlushPending(pending);
                }
            }
            catch (Exception ex)
            {
                // A persistently failing native decode used to vanish here with
                // no trace; keep the batch-drop behavior but leave a breadcrumb.
                System.Diagnostics.Debug.WriteLine($"[QrDecodePool] decode/flush failed: {ex}");
                pending.Clear();
            }
            finally
            {
                frame.Dispose();
            }
        }

        if (pending.Count > 0)
        {
            FlushPending(pending);
        }
    }

    private void FlushPending(List<PendingSymbol> pending)
    {
        lock (IngestLock)
        {
            foreach (PendingSymbol symbol in pending)
            {
                if (IngestStopped)
                {
                    break;
                }
                if (_onDecoded(symbol.Payload, symbol.Bbox))
                {
                    IngestStopped = true;
                    break;
                }
            }
        }
        pending.Clear();
    }

    private List<ZxingDecoder.MultiResult> DecodeMultiTracked(GrayFrame frame)
    {
        int[]? tracked;
        int lockedCount;
        lock (_trackingGate)
        {
            tracked = _multiTrackedBboxes;
            lockedCount = _multiLockedCount;
        }

        // The periodic full-frame re-lock counts CONSECUTIVE misses: the miss
        // counter is reset to 0 on any success, and `0 % N == 0` would then
        // force a full-frame scan on EVERY frame — exactly what the tracked
        // fast path exists to avoid. Only miss counts that are > 0 and land on
        // the boundary trigger the cold path (mirrors Android's fix).
        long misses = Interlocked.Read(ref _multiMisses);
        bool dueFullLock = tracked is null || lockedCount == 0 ||
            (misses > 0 && misses % MultiFullDecodeEvery == 0);
        if (!dueFullLock && tracked is not null && lockedCount > 0)
        {
            List<ZxingDecoder.MultiResult> regionResults = ZxingDecoder.DecodeMulti(
                frame.Pixels, frame.Length, frame.Width, frame.Height, frame.RowStride,
                tracked, lockedCount, TrackMargin);
            if (regionResults.Count > 0)
            {
                UpdateTrackedSlots(regionResults);
                Interlocked.Exchange(ref _multiMisses, 0);
                return regionResults;
            }
            Interlocked.Increment(ref _multiMisses);
        }

        List<ZxingDecoder.MultiResult> fullResults = DecodeMultiFull(frame);
        if (fullResults.Count > 0)
        {
            SeedTrackedSlots(fullResults);
            Interlocked.Exchange(ref _multiMisses, 0);
        }
        else
        {
            Interlocked.Increment(ref _multiMisses);
        }
        return fullResults;
    }

    private static List<ZxingDecoder.MultiResult> DecodeMultiFull(GrayFrame frame) =>
        ZxingDecoder.DecodeMulti(
            frame.Pixels, frame.Length, frame.Width, frame.Height, frame.RowStride,
            hints: null, hintCount: 0, marginFraction: TrackMargin);

    private void SeedTrackedSlots(IReadOnlyList<ZxingDecoder.MultiResult> results)
    {
        if (results.Count == 0)
        {
            return;
        }
        int[] packed = new int[results.Count * 4];
        for (int index = 0; index < results.Count; index++)
        {
            Array.Copy(results[index].Bbox, 0, packed, index * 4, 4);
        }
        lock (_trackingGate)
        {
            _multiTrackedBboxes = packed;
            _multiLockedCount = results.Count;
        }
    }

    private void UpdateTrackedSlots(IReadOnlyList<ZxingDecoder.MultiResult> results)
    {
        lock (_trackingGate)
        {
            int[]? old = _multiTrackedBboxes;
            int count = _multiLockedCount;
            if (old is null || count == 0)
            {
                SeedTrackedSlots(results);
                return;
            }

            int[] updated = (int[])old.Clone();
            bool[] claimed = new bool[count];
            foreach (ZxingDecoder.MultiResult result in results)
            {
                int centerX = (result.Bbox[0] + result.Bbox[2]) / 2;
                int centerY = (result.Bbox[1] + result.Bbox[3]) / 2;
                int bestSlot = -1;
                long bestDistance = long.MaxValue;
                for (int slot = 0; slot < count; slot++)
                {
                    if (claimed[slot])
                    {
                        continue;
                    }
                    int oldCenterX = (old[slot * 4] + old[slot * 4 + 2]) / 2;
                    int oldCenterY = (old[slot * 4 + 1] + old[slot * 4 + 3]) / 2;
                    long dx = (long)centerX - oldCenterX;
                    long dy = (long)centerY - oldCenterY;
                    long distance = dx * dx + dy * dy;
                    if (distance < bestDistance)
                    {
                        bestDistance = distance;
                        bestSlot = slot;
                    }
                }
                if (bestSlot >= 0)
                {
                    claimed[bestSlot] = true;
                    Array.Copy(result.Bbox, 0, updated, bestSlot * 4, 4);
                }
            }
            _multiTrackedBboxes = updated;
        }
    }

    public T RunExclusive<T>(Func<T> action)
    {
        lock (IngestLock)
        {
            return action();
        }
    }

    public void Stop()
    {
        if (!_running)
        {
            return;
        }
        _running = false;
        _cts.Cancel();
        _queue.CompleteAdding();
        // Bounded join: _cts.Cancel() only interrupts TryTake; a worker currently
        // inside ZxingDecoder.DecodeMulti (native C++ finder scan over a 1080p
        // frame, which can take tens of ms — or much longer on a pathological
        // frame) cannot be interrupted and would block an unbounded Join()
        // forever. That would hang the whole teardown (Stop is called from the
        // background cleanup task) and, if the app exits while it's stuck, leak
        // the DirectShow capture handle (camera locked system-wide). Mirror the
        // Android pool's bounded join(300ms) pattern with a 2s ceiling per
        // worker — enough for a slow decode to finish, short enough that a
        // wedged worker cannot deadlock teardown. Workers are managed threads,
        // so a join timeout just abandons them to be reaped at process exit.
        foreach (Thread worker in _workers)
        {
            if (!worker.Join(2_000))
            {
                // Worker wedged in native decode; abandon it rather than hang
                // teardown. The native receiver/capture are still disposed on
                // this thread; only the stuck worker thread leaks (reaped at
                // process exit).
            }
        }
        _workers.Clear();
        while (_queue.TryTake(out GrayFrame? frame))
        {
            frame.Dispose();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }
        Stop();
        _cts.Dispose();
        _queue.Dispose();
    }
}
