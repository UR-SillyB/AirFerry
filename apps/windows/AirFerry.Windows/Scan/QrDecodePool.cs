using System.Collections.Concurrent;
using OpenCvSharp;
using ZXing;

namespace AirFerry.Windows.Scan;

/// <summary>
/// Decouples video capture from QR decoding + native ingest — the Windows
/// counterpart of Android's <c>QrDecodePool.kt</c>. A single producer thread
/// pulls frames from <see cref="VideoCapture"/> and enqueues each as a pooled
/// grayscale buffer; N worker threads drain the queue and run ZXing.Net on each
/// frame. Every decoded payload is handed to <see cref="OnDecoded"/> under a
/// single <see cref="IngestLock"/>, so the non-thread-safe native receiver
/// (<see cref="ReceiverSession"/>) is only ever touched by one thread at a
/// time — exactly like Android's <c>ingestLock</c>.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why batch the ingest:</b> the single hottest contention point in the
/// pipeline is the serialized ingest lock (it guards a non-thread-safe native
/// handle). Accumulating <see cref="IngestBatch"/> symbols before acquiring the
/// lock cuts lock/fence traffic by the batch factor, directly raising
/// steady-state symbol throughput. The <see cref="OnDecoded"/> callback is
/// self-defending: it checks <see cref="_ingestStopped"/> at its top, so once a
/// symbol completes recovery every later symbol (in the same batch or any future
/// frame) is skipped — no batch-aware stop logic needed in the pool.
/// </para>
/// <para>
/// <b>Drop-newest backpressure:</b> fountain symbols are independent, so
/// dropping the freshest frame when the queue is full is harmless and never
/// stalls the camera — matches Android's <c>ArrayBlockingQueue</c> + drop policy.
/// </para>
/// <para>
/// <b>Multi-QR:</b> the first version uses full-frame <c>DecodeMultiple</c>
/// (no ROI tracking optimization). Desktop CPUs are faster than phones and
/// capture-card frame rates are typically 30-60 fps, so the finder scan cost is
/// acceptable. The tracked-ROI optimization from Android is a future enhancement.
/// </para>
/// </remarks>
public sealed class QrDecodePool : IDisposable
{
    /// <summary>
    /// Worker count mirrors Android's <c>(cores - 3).clamp(2, 6)</c>: subtract 3
    /// for the producer, UI thread, and ingest path overhead.
    /// </summary>
    public int WorkerCount { get; } = Math.Clamp(Environment.ProcessorCount - 3, 2, 6);

    /// <summary>
    /// Symbols accumulated per worker before acquiring <see cref="IngestLock"/> —
    /// cuts lock contention by this factor. Matches Android's <c>INGEST_BATCH</c>.
    /// </summary>
    private const int IngestBatch = 4;

    /// <summary>AFGrid side length (0 = QR only). 226 ≈ symbol_size 5600.</summary>
    public int AfgridExpectedSide { get; set; } = 226;

    /// <summary>
    /// Maximum frames buffered between producer and workers. Drop-newest when full.
    /// Mirrors Android's <c>ArrayBlockingQueue(workerCount + 2)</c>.
    /// </summary>
    private readonly int _queueCapacity;

    private readonly BlockingCollection<GrayFrame> _queue;
    private readonly List<Thread> _workers = [];
    private readonly CancellationTokenSource _cts = new();
    private volatile bool _running;
    private int _disposed;

    // Metrics (read by the UI for live diagnostics).
    private long _capturedFrames;
    private long _droppedFrames;
    /// <summary>Count of decoded symbols (QR codes), not frames.</summary>
    private long _decodedSymbols;

    /// <summary>
    /// Set true the instant recovery completes, so every later <see cref="OnDecoded"/>
    /// call short-circuits. The main thread reads it before assembling the file
    /// to guarantee the <c>&amp;</c> borrow can't race a worker's <c>&amp;mut</c> ingest.
    /// </summary>
    internal volatile bool IngestStopped;

    /// <summary>
    /// Serialized ingest lock — every <see cref="ReceiverSession"/> call goes
    /// through here. Also guards the final assemble (see <see cref="RunExclusive"/>).
    /// </summary>
    internal readonly object IngestLock = new();

    /// <summary>The callback invoked (under <see cref="IngestLock"/>) per decoded QR.</summary>
    private readonly Func<byte[], bool> _onDecoded;

    /// <summary>A captured grayscale frame; <see cref="Pixels"/> is a pooled buffer.</summary>
    private sealed class GrayFrame(byte[] pixels, int width, int height)
    {
        public byte[] Pixels { get; } = pixels;
        public int Width { get; } = width;
        public int Height { get; } = height;
    }

    public long CapturedFrames => Interlocked.Read(ref _capturedFrames);
    public long DroppedFrames => Interlocked.Read(ref _droppedFrames);
    public long DecodedSymbols => Interlocked.Read(ref _decodedSymbols);

    /// <param name="onDecoded">
    /// Invoked under <see cref="IngestLock"/> with each decoded QR payload.
    /// Returns true if this symbol completed recovery (the pool then stops
    /// ingesting further symbols).
    /// </param>
    public QrDecodePool(Func<byte[], bool> onDecoded)
    {
        _onDecoded = onDecoded;
        _queueCapacity = WorkerCount + 2;
        _queue = new BlockingCollection<GrayFrame>(_queueCapacity);
    }

    public void Start()
    {
        if (_running)
        {
            return;
        }
        _running = true;
        for (int i = 0; i < WorkerCount; i++)
        {
            var t = new Thread(() => WorkerLoop(_cts.Token))
            {
                IsBackground = true,
                Name = $"qr-decode-{i}",
            };
            _workers.Add(t);
            t.Start();
        }
    }

    /// <summary>
    /// Producer entry: copy a grayscale Mat's pixels into a fresh buffer and
    /// enqueue it. Drop-newest when the queue is full. Returns false (does not
    /// throw) if the pool is stopped/disposed.
    /// </summary>
    /// <remarks>
    /// We clone the Mat's pixels because the <see cref="VideoCapture"/> reuses
    /// its internal Mat across reads; the worker may not run before the next
    /// frame overwrites it.
    /// </remarks>
    public bool Submit(Mat gray)
    {
        if (!_running || _disposed != 0)
        {
            return false;
        }
        if (gray.Empty() || gray.Width <= 0 || gray.Height <= 0)
        {
            return false;
        }
        Interlocked.Increment(ref _capturedFrames);
        int width = gray.Width;
        int height = gray.Height;
        // Extract the grayscale pixels. GetArray returns the raw pixel bytes for
        // a CV_8UC1 Mat; it allocates a new array internally, but that's the
        // buffer we hand to the decoder — no separate copy needed.
        if (!gray.GetArray(out byte[]? pixels) || pixels is null)
        {
            Interlocked.Increment(ref _droppedFrames);
            return false;
        }
        // The common case is step == width, so GetArray already gave us a
        // width*height buffer. For padded Mats GetArray still returns a compact
        // width*height array (OpenCvSharp strips the stride), so no extra handling.
        var frame = new GrayFrame(pixels, width, height);
        if (!_queue.TryAdd(frame, 0))
        {
            // Drop-newest: a full queue means workers can't keep up; the freshest
            // frame is least likely to carry a still-missing symbol, so drop it.
            Interlocked.Increment(ref _droppedFrames);
            return false;
        }
        return true;
    }

    private void WorkerLoop(CancellationToken ct)
    {
        // Per-worker reader (ZXing BarcodeReader is not thread-safe).
        BarcodeReader<LuminanceSource> reader = ZxingDecoder.CreateReader();
        var pending = new List<byte[]>(IngestBatch);

        while (_running && !ct.IsCancellationRequested)
        {
            if (!_queue.TryTake(out GrayFrame? frame, 200, ct))
            {
                continue;
            }
            try
            {
                // Build a luminance source straight over the extracted pixels —
                // no need to reconstruct a Mat (the producer already extracted a
                // compact width*height byte[] via Mat.GetArray).
                byte[]? af = ZxingDecoder.DecodeAfgrid(frame.Pixels, frame.Width, frame.Height, AfgridExpectedSide);
                if (af is not null)
                {
                    Interlocked.Increment(ref _decodedSymbols);
                    pending.Add(af);
                }
                var source = new MatLuminanceSource(frame.Pixels, frame.Width, frame.Height);
                List<byte[]> results = ZxingDecoder.DecodeMultiple(reader, source);
                if (results.Count > 0)
                {
                    Interlocked.Add(ref _decodedSymbols, results.Count);
                    pending.AddRange(results);
                }
                // Flush the batch under one lock acquire when it fills, or when
                // the queue has run dry (drain eagerly so latency stays low).
                if (pending.Count >= IngestBatch || (pending.Count > 0 && _queue.Count == 0))
                {
                    lock (IngestLock)
                    {
                        foreach (byte[] payload in pending)
                        {
                            if (IngestStopped)
                            {
                                break;
                            }
                            if (_onDecoded(payload))
                            {
                                // Completion signaled — stop ingesting the rest.
                                IngestStopped = true;
                                break;
                            }
                        }
                    }
                    pending.Clear();
                }
            }
            catch
            {
                // Never let a worker die on one bad frame. Drop an un-flushed
                // batch too so a poisoned symbol can't stall the next iteration.
                pending.Clear();
            }
        }

        // Worker shutting down: flush anything still pending so we never lose
        // the tail of a transfer to a pool teardown.
        if (pending.Count > 0)
        {
            lock (IngestLock)
            {
                foreach (byte[] payload in pending)
                {
                    if (IngestStopped)
                    {
                        break;
                    }
                    _onDecoded(payload);
                }
            }
            pending.Clear();
        }
    }

    /// <summary>
    /// Run <paramref name="action"/> under <see cref="IngestLock"/> — used by the
    /// scan VM to run the final assemble with the same lock that serializes
    /// ingest, preventing any straggler worker from racing the <c>&amp;</c> borrow.
    /// </summary>
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
        foreach (Thread t in _workers)
        {
            t.Join(TimeSpan.FromSeconds(2));
        }
        _workers.Clear();
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
