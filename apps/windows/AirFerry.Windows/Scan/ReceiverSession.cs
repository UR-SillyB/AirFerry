using System.Runtime.InteropServices;
using System.Text;
using AirFerry.Windows.Native;

namespace AirFerry.Windows.Scan;

/// <summary>
/// High-level receiver session manager — the Windows equivalent of Android's
/// <c>ReceiverSessionManager.kt</c>. Wraps the Rust C ABI and drives the same
/// state machine: lazy-init from the first descriptor frame, then a forced
/// re-init if the session-mismatch streak climbs without ever accepting a
/// symbol.
/// </summary>
/// <remarks>
/// <para>
/// The native receiver is <b>only</b> initialized from a descriptor frame
/// (<see cref="FrameHeader.FlagDescriptor"/>). Ordinary data frames are
/// silently dropped until a descriptor arrives. This prevents a corrupted
/// first QR decode (which only passes magic+version but may carry a garbage
/// session_id) from permanently locking out every subsequent correct frame.
/// </para>
/// <para>
/// Once initialized, a persistent session-mismatch streak with zero accepted
/// symbols triggers a forced re-init from the next descriptor that arrives —
/// covering the edge-case where the first descriptor itself was corrupted but
/// a later one is clean.
/// </para>
/// <para>
/// Every access to the native handle is serialized by this wrapper. Callers may
/// poll progress while ingest is running and may dispose only after producers
/// have been stopped.
/// </para>
/// </remarks>
public sealed class ReceiverSession : IDisposable
{
    private readonly object _gate = new();
    private IntPtr _handle = IntPtr.Zero;
    private ulong _sessionIdLo;
    private ulong _sessionIdHi;
    private uint _symbolSize;
    private bool _initialized;
    private int _estimatedTotalSymbols;
    private int _mismatchStreak;
    private bool _everAccepted;

    public bool IsInitialized { get { lock (_gate) return _initialized; } }
    public int EstimatedTotalSymbols { get { lock (_gate) return _estimatedTotalSymbols; } }
    public uint SymbolSizeBytes { get { lock (_gate) return _symbolSize; } }

    /// <summary>
    /// Ingest a decoded QR payload. Returns a lightweight
    /// <see cref="IngestStatus"/> (no JSON) so the hot ingest path doesn't
    /// allocate/parse a string per frame; call <see cref="Progress"/> on the
    /// UI refresh cadence for the full snapshot.
    /// </summary>
    public IngestStatus? Ingest(byte[] frameBytes)
    {
        lock (_gate)
        {
        FrameHeader? header = FrameHeader.Parse(frameBytes);
        if (header is null)
        {
            return null;
        }
        FrameHeader h = header.Value;

        // Cache estimated total symbols from the first frame for approximate
        // UI progress before the descriptor arrives.
        if (_estimatedTotalSymbols == 0 && h.TotalSymbols > 0)
        {
            _estimatedTotalSymbols = (int)h.TotalSymbols;
        }

        bool isDescriptor = h.IsDescriptor;

        // --- Lazy init: only from descriptor frames ---
        // Until a descriptor arrives the authoritative OTI is unknown; feeding
        // data frames to a guessed decoder (the old path) corrupted multi-block
        // recovery. Drop them silently and wait.
        if (!_initialized)
        {
            if (!isDescriptor)
            {
                return null; // wait for a descriptor
            }
            CreateReceiver(h);
            if (!_initialized)
            {
                return null;
            }
        }

        // --- Session-mismatch re-init ---
        // If the streak is high and we never accepted anything, the first
        // descriptor was likely corrupt → destroy and re-init on the next
        // descriptor (the next Ingest call re-enters the lazy-init block above).
        if (_initialized && !isDescriptor && _mismatchStreak >= 3 && !_everAccepted)
        {
            Destroy();
            return null;
        }

        ulong word = NativeBridge.ReceiverIngest(_handle, frameBytes, (nuint)frameBytes.Length);
        IngestStatus? status = IngestStatus.Unpack(word);
        if (status is null)
        {
            return null; // error sentinel: rejected frame, nothing to do.
        }
        IngestStatus s = status.Value;

        // Track mismatch streak for the re-init heuristic above.
        if (s.MismatchStreak >= 3)
        {
            _mismatchStreak = s.MismatchStreak;
        }
        else if (s.Accepted)
        {
            _everAccepted = true;
            _mismatchStreak = 0;
        }

        return s;
        }
    }

    /// <summary>
    /// Full progress snapshot (parsed from the on-demand JSON). Intended for
    /// the UI refresh cadence (~7 Hz), NOT per-frame. Returns <see langword="null"/>
    /// if the session isn't initialized or the native call fails.
    /// </summary>
    public ProgressSnapshot? Progress()
    {
        lock (_gate)
        {
        if (!_initialized || _handle == IntPtr.Zero)
        {
            return null;
        }

        // Two-pass length protocol: first learn the required length, then fill.
        nuint needed = NativeBridge.ReceiverProgressJson(_handle, null, 0);
        if (needed == 0)
        {
            return null;
        }
        if (needed > int.MaxValue)
        {
            return null;
        }
        byte[] buf = new byte[(int)needed];
        nuint written = NativeBridge.ReceiverProgressJson(_handle, buf, (nuint)buf.Length);
        if (written == 0 || written > (nuint)buf.Length)
        {
            return null;
        }
        // The JSON is NUL-terminated; trim the trailing NUL before parsing.
        int len = (int)written - 1;
        if (len <= 0)
        {
            return null;
        }
        string json = Encoding.UTF8.GetString(buf, 0, len);
        return ProgressSnapshot.Parse(json);
        }
    }

    public bool IsComplete
    {
        get
        {
            lock (_gate)
            {
                return _initialized && NativeBridge.ReceiverIsComplete(_handle) == 1;
            }
        }
    }

    /// <summary>Original filename from the descriptor, or empty.</summary>
    public string FileName()
    {
        lock (_gate)
        {
        if (!_initialized)
        {
            return string.Empty;
        }
        return ReadCString(NativeBridge.ReceiverFileName);
        }
    }

    /// <summary>Original file size, or 0.</summary>
    public ulong FileSize()
    {
        lock (_gate) return _initialized ? NativeBridge.ReceiverFileSize(_handle) : 0UL;
    }

    /// <summary>Expected CRC32 (unsigned 32-bit in a ulong), or 0.</summary>
    public ulong Crc32()
    {
        lock (_gate) return _initialized ? NativeBridge.ReceiverCrc32(_handle) : 0UL;
    }

    /// <summary>
    /// True if the descriptor supplied a real CRC32 (so the receiver should
    /// verify it). Use this — NOT <c>Crc32() == 0</c> — to decide whether to
    /// verify: CRC32 can legitimately be 0.
    /// </summary>
    public bool Crc32Known()
    {
        lock (_gate) return _initialized && NativeBridge.ReceiverCrc32Known(_handle) == 1;
    }

    // ── descriptor-v5 segment metadata (large-transfer child objects) ───────

    /// <summary>1 if the confirmed descriptor was a v5 large-transfer child object.</summary>
    public bool IsSegmented()
    {
        lock (_gate) return _initialized && NativeBridge.ReceiverIsSegmented(_handle) == 1;
    }

    /// <summary>Zero-based index of this segment within the root transfer (0 if not segmented).</summary>
    public uint SegmentIndex()
    {
        lock (_gate) return _initialized ? NativeBridge.ReceiverSegmentIndex(_handle) : 0u;
    }

    /// <summary>Total segment count of the root transfer (1 if not segmented).</summary>
    public uint SegmentCount()
    {
        lock (_gate) return _initialized ? NativeBridge.ReceiverSegmentCount(_handle) : 1u;
    }

    /// <summary>Root (whole-file) original size in bytes (0 if not segmented).</summary>
    public ulong RootOriginalSize()
    {
        lock (_gate) return _initialized ? NativeBridge.ReceiverRootOriginalSize(_handle) : 0UL;
    }

    /// <summary>Original (uncompressed) offset of this segment in the root file (0 if not segmented).</summary>
    public ulong OriginalOffset()
    {
        lock (_gate) return _initialized ? NativeBridge.ReceiverOriginalOffset(_handle) : 0UL;
    }

    /// <summary>Root session id low 64 bits (whole transfer id), or 0 if not segmented.</summary>
    public ulong RootSessionIdLo()
    {
        lock (_gate) return _initialized ? NativeBridge.ReceiverRootSessionIdLo(_handle) : 0UL;
    }

    /// <summary>Root session id high 64 bits, or 0 if not segmented.</summary>
    public ulong RootSessionIdHi()
    {
        lock (_gate) return _initialized ? NativeBridge.ReceiverRootSessionIdHi(_handle) : 0UL;
    }

    /// <summary>32-byte SHA-256 of this segment's uncompressed bytes, or empty if not segmented.</summary>
    public byte[] RawSha256()
    {
        lock (_gate)
        {
            if (!_initialized) return Array.Empty<byte>();
            var len = NativeBridge.ReceiverRawSha256(_handle, null, 0);
            if (len == 0) return Array.Empty<byte>();
            var buf = new byte[len];
            NativeBridge.ReceiverRawSha256(_handle, buf, len);
            return buf;
        }
    }

    /// <summary>32-byte SHA-256 of the complete root file, or empty if not segmented.</summary>
    public byte[] RootSha256()
    {
        lock (_gate)
        {
            if (!_initialized) return Array.Empty<byte>();
            var len = NativeBridge.ReceiverRootSha256(_handle, null, 0);
            if (len == 0) return Array.Empty<byte>();
            var buf = new byte[len];
            NativeBridge.ReceiverRootSha256(_handle, buf, len);
            return buf;
        }
    }

    /// <summary>
    /// Recover the assembled file bytes, trimming RaptorQ zero-padding back to
    /// the descriptor's original size (mirrors Android's
    /// <c>recoverAndStage</c>). Returns <see langword="null"/> if not complete.
    /// </summary>
    /// <remarks>
    /// The buffer returned by the Rust side is Rust-allocated; this method
    /// copies the bytes into a managed array and frees the native allocation
    /// before returning, so the caller never touches unmanaged memory.
    /// </remarks>
    public byte[]? Assemble()
    {
        lock (_gate)
        {
        if (!_initialized)
        {
            return null;
        }
        int ok = NativeBridge.ReceiverAssemble(_handle, out IntPtr buf, out nuint len);
        if (ok == 0 || buf == IntPtr.Zero || len == 0)
        {
            return null;
        }
        if (len > int.MaxValue)
        {
            NativeBridge.BufferFree(buf, len);
            return null;
        }
        try
        {
            // Copy the whole recovered object (may include trailing zero pad).
            byte[] all = new byte[(int)len];
            Marshal.Copy(buf, all, 0, (int)len);
            ulong original = NativeBridge.ReceiverFileSize(_handle);
            // Trim zero-padding back to the true length. If the descriptor
            // didn't carry a size (0), keep the whole recovered buffer.
            int truncLen = original > 0 && original <= len
                ? (int)original : (int)len;
            if (truncLen == all.Length)
            {
                return all;
            }
            Array.Resize(ref all, truncLen);
            return all;
        }
        finally
        {
            // Always release the Rust allocation, even on exception.
            NativeBridge.BufferFree(buf, len);
        }
        }
    }

    /// <summary>
    /// Reassemble this segment's transmitted (compressed) bytes as received,
    /// without decompression. Returns the raw bytes, or null when incomplete.
    /// </summary>
    public byte[]? AssembleRaw()
    {
        lock (_gate)
        {
            if (!_initialized) return null;
            int ok = NativeBridge.ReceiverAssembleRaw(_handle, out IntPtr buf, out nuint len);
            if (ok == 0 || buf == IntPtr.Zero || len == 0) return null;
            if (len > int.MaxValue)
            {
                NativeBridge.BufferFree(buf, len);
                return null;
            }
            try
            {
                byte[] all = new byte[(int)len];
                Marshal.Copy(buf, all, 0, (int)len);
                return all;
            }
            finally
            {
                NativeBridge.BufferFree(buf, len);
            }
        }
    }

    /// <summary>Compression-algorithm tag of the confirmed descriptor.</summary>
    public byte Compression()
    {
        lock (_gate) return _initialized ? NativeBridge.ReceiverCompression(_handle) : (byte)0;
    }

    /// <summary>This object's transmitted (compressed) payload length.</summary>
    public ulong CompressedSize()
    {
        lock (_gate) return _initialized ? NativeBridge.ReceiverCompressedSize(_handle) : 0UL;
    }

    /// <summary>Whole decompressed original size (same across segments of a root).</summary>
    public ulong OriginalSize()
    {
        lock (_gate) return _initialized ? NativeBridge.ReceiverOriginalSize(_handle) : 0UL;
    }

    /// <summary>This child session's id, split exactly as the wire stores it.</summary>
    public (ulong Lo, ulong Hi) SessionId()
    {
        lock (_gate) return (_sessionIdLo, _sessionIdHi);
    }

    /// <summary>Session id as a lowercase hex string (high||low, 32 chars).</summary>
    public string SessionIdHex()
    {
        lock (_gate)
        {
            string lo = _sessionIdLo.ToString("x16");
            string hi = _sessionIdHi.ToString("x16");
            return hi + lo;
        }
    }

    /// <summary>Create (or re-create) the native receiver from a parsed header.</summary>
    private void CreateReceiver(FrameHeader h)
    {
        _sessionIdLo = h.SessionIdLo;
        _sessionIdHi = h.SessionIdHi;
        _symbolSize = h.SymbolSize > 0 ? h.SymbolSize : 1024;
        _handle = NativeBridge.ReceiverCreate(_sessionIdLo, _sessionIdHi);
        _initialized = _handle != IntPtr.Zero;
        _mismatchStreak = 0;
        _everAccepted = false;
    }

    /// <summary>
    /// Shared helper for the two-pass length protocol used by
    /// <c>ReceiverFileName</c> / <c>ReceiverProgressJson</c>.
    /// </summary>
    private delegate nuint StringReader(IntPtr handle, byte[]? buf, nuint cap);

    private string ReadCString(StringReader reader)
    {
        nuint needed = reader(_handle, null, 0);
        if (needed == 0)
        {
            return string.Empty;
        }
        if (needed > int.MaxValue)
        {
            return string.Empty;
        }
        byte[] buf = new byte[(int)needed];
        nuint written = reader(_handle, buf, (nuint)buf.Length);
        if (written == 0)
        {
            return string.Empty;
        }
        // The buffer is NUL-terminated; the last byte is the NUL.
        int len = (int)written - 1;
        return len > 0 ? Encoding.UTF8.GetString(buf, 0, len) : string.Empty;
    }

    public void Destroy()
    {
        lock (_gate)
        {
        if (_initialized && _handle != IntPtr.Zero)
        {
            NativeBridge.ReceiverDestroy(_handle);
            _handle = IntPtr.Zero;
            _initialized = false;
        }
        }
    }

    public void Dispose() => Destroy();
}
