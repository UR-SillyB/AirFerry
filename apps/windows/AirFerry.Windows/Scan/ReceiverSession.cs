using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using AirFerry.Windows.Native;

namespace AirFerry.Windows.Scan;

/// <summary>
/// High-level receiver session manager — the Windows equivalent of Android's
/// <c>ReceiverSessionManager.kt</c>. Frames pass straight through to the Rust
/// C-ABI receiver, which owns the entire AF2 state machine (frame validation,
/// ROOT lock / 3-ROOT debounce re-lock, object routing, OTI integrity).
/// </summary>
/// <remarks>
/// <para>
/// No wire-format parsing happens on the C# side (SPEC §9: hosts must not
/// mirror the wire protocol). The packed <see cref="IngestStatus"/> word and
/// the snapshot JSON are the only native surfaces consumed here.
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
    private bool _initialized;
    private bool _destroyed;
    private Snapshot? _cachedSnapshot;

    public bool IsInitialized { get { lock (_gate) return _initialized; } }
    /// <summary>Estimated total symbols from the locked transfer (0 before ROOT).</summary>
    public int EstimatedTotalSymbols
    {
        get
        {
            var snap = GetSnapshot();
            if (!snap.MetaConfirmed || snap.SymbolSize == 0) return 0;
            return (int)Math.Min(int.MaxValue,
                (snap.TotalRawSize + snap.SymbolSize - 1) / snap.SymbolSize);
        }
    }

    /// <summary>Begin bounded-memory §13 ⑧⑨ final verification.</summary>
    public bool FinalVerifyBegin()
    {
        lock (_gate)
        {
            return _initialized && _handle != IntPtr.Zero &&
                NativeBridge.ReceiverFinalVerifyBegin(_handle) == 1;
        }
    }

    /// <summary>Feed the next contiguous canonical-stream block.</summary>
    public bool FinalVerifyFeed(byte[] streamBytes)
    {
        lock (_gate)
        {
            if (!_initialized || _handle == IntPtr.Zero || streamBytes is null)
            {
                return false;
            }
            return NativeBridge.ReceiverFinalVerifyFeed(
                _handle, streamBytes, (nuint)streamBytes.Length) == 1;
        }
    }

    /// <summary>Finish bounded-memory §13 ⑧⑨ final verification.</summary>
    public bool FinalVerifyFinish()
    {
        lock (_gate)
        {
            return _initialized && _handle != IntPtr.Zero &&
                NativeBridge.ReceiverFinalVerifyFinish(_handle) == 1;
        }
    }
    /// <summary>Wire symbol size T reported by Rust (0 before lock).</summary>
    public uint SymbolSizeBytes { get { var snap = GetSnapshot(); return snap.SymbolSize; } }

    /// <summary>
    /// Ingest a decoded QR payload. Direct passthrough to the native AF2 receiver
    /// engine, which holds the single source-of-truth state machine (frame validation,
    /// 3-ROOT debounce, object routing, and OTI integrity).
    /// </summary>
    public IngestStatus? Ingest(byte[] frameBytes)
    {
        lock (_gate)
        {
            if (frameBytes is null || frameBytes.Length == 0)
            {
                return null;
            }

            // A destroyed session must not silently re-create a native receiver
            // nobody owns (leak) — a straggler decode flush after teardown used
            // to hit this.
            if (_destroyed)
            {
                return null;
            }

            if (!_initialized)
            {
                CreateReceiver();
                if (!_initialized)
                {
                    return null;
                }
            }

            ulong word = NativeBridge.ReceiverIngest(_handle, frameBytes, (nuint)frameBytes.Length);
            IngestStatus? status = IngestStatus.Unpack(word);
            if (status is null)
            {
                return null; // error sentinel: rejected frame, nothing to do.
            }
            IngestStatus s = status.Value;

            if (s.Relocked)
            {
                // A foreign transfer owns the session: clear the stale snapshot
                // cache. (Never infer this from Accepted && ReceivedSymbols == 0
                // — that signature also matches the first accepted META of a
                // §12-resumed session.)
                _cachedSnapshot = null;
            }

            return s;
        }
    }

    private void CreateReceiver()
    {
        _handle = NativeBridge.ReceiverCreate(0, 0);
        _initialized = _handle != IntPtr.Zero;
        _cachedSnapshot = null;
    }

    /// <summary>Verify a staged raw chunk against the ROOT-bound Manifest table (§11).</summary>
    public bool VerifyChunk(uint index, byte[] rawBytes)
    {
        lock (_gate)
        {
            if (!_initialized || _handle == IntPtr.Zero || rawBytes is null)
            {
                return false;
            }
            return NativeBridge.ReceiverVerifyChunk(_handle, index, rawBytes, (nuint)rawBytes.Length) == 1;
        }
    }

    /// <summary>Run §13 ⑧⑨ integrity chain over the reassembled canonical stream.</summary>
    public bool VerifyFinalStream(byte[] streamBytes)
    {
        lock (_gate)
        {
            if (!_initialized || _handle == IntPtr.Zero || streamBytes is null)
            {
                return false;
            }
            return NativeBridge.ReceiverVerifyFinalStream(_handle, streamBytes, (nuint)streamBytes.Length) == 1;
        }
    }

    /// <summary>
    /// Evict one chunk from both ledgers after a spill re-verification
    /// failure (§11/§12): the sender's next epoch re-supplies it.
    /// </summary>
    public bool InvalidateChunk(uint index)
    {
        lock (_gate)
        {
            if (!_initialized || _handle == IntPtr.Zero)
            {
                return false;
            }
            return NativeBridge.ReceiverInvalidateChunk(_handle, index) == 1;
        }
    }

    /// <summary>Restore session from stored ROOT frame bytes + completed chunk indices (§12 resume).</summary>
    public bool Resume(byte[] rootFrameBytes, uint[] completedIndices)
    {
        lock (_gate)
        {
            if (_destroyed)
            {
                return false;
            }
            if (!_initialized)
            {
                CreateReceiver();
            }
            if (!_initialized || _handle == IntPtr.Zero || rootFrameBytes is null || completedIndices is null)
            {
                return false;
            }
            return NativeBridge.ReceiverResume(_handle, rootFrameBytes, (nuint)rootFrameBytes.Length, completedIndices, (nuint)completedIndices.Length) == 1;
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

    // ── AF2 snapshot (ReceiverSnapshotV2) ────────────────────────────────────
    //
    // The former 16 per-field P/Invoke getters were folded into ONE
    // `airferry_receiver_snapshot_json` call (native ABI v2). The public
    // per-field methods below keep their shapes so callers are unchanged, but
    // read a cached snapshot: snapshot fields are immutable once
    // `meta_confirmed` is true, so the cache refreshes only until confirmation
    // and freezes afterwards — one P/Invoke + one JSON parse per session
    // instead of 16 per UI refresh.

    /// <summary>Parsed <c>ReceiverSnapshotV2</c> fields.</summary>
    public sealed class Snapshot
    {
        public bool MetaConfirmed;
        public string TransferIdHex = "";
        public string ContentIdHex = "";
        public ulong TotalRawSize;
        public uint EntryCount;
        public uint ChunkCount;
        public uint ChunkRawSize;
        public uint SymbolSize;
        public IReadOnlyList<ManifestEntryDto> Entries = Array.Empty<ManifestEntryDto>();
        /// <summary>v1-magic frames rejected so far; &gt; 0 ⇒ the peer runs protocol 1.</summary>
        public uint LegacyPeerFrames;
        /// <summary>Canonical ROOT frame bytes (for the §12 resume ledger).</summary>
        public byte[] RootFrameBytes = Array.Empty<byte>();
    }

    /// <summary>One AF2 Manifest entry (kind/path/savePath/offset/size).</summary>
    public sealed record ManifestEntryDto(int Kind, string Path, string SavePath, ulong Offset, ulong Size);

    /// <summary>Current snapshot (cached once the manifest has entries).</summary>
    public Snapshot GetSnapshot()
    {
        lock (_gate)
        {
            if (!_initialized)
            {
                return new Snapshot();
            }
            // Freeze only once the Manifest is decoded. `meta_confirmed` in
            // the AF2 snapshot merely means the ROOT locked — freezing there
            // (a v1-era refactor) pins Entries = [] for the whole session and
            // staging falls back to one nameless concatenated file.
            if (_cachedSnapshot is { MetaConfirmed: true, Entries.Count: > 0 } cached)
            {
                return cached;
            }
            IntPtr ptr = NativeBridge.ReceiverSnapshotJson(_handle);
            if (ptr == IntPtr.Zero)
            {
                return _cachedSnapshot ?? new Snapshot();
            }
            try
            {
                string json = Marshal.PtrToStringUTF8(ptr) ?? "";
                using var doc = System.Text.Json.JsonDocument.Parse(
                    json, new System.Text.Json.JsonDocumentOptions { AllowTrailingCommas = true });
                var root = doc.RootElement;
                var snap = new Snapshot
                {
                    MetaConfirmed = root.TryGetProperty("meta_confirmed", out var mc) && mc.GetBoolean(),
                    TransferIdHex = root.TryGetProperty("transfer_id_hex", out var tid) ? tid.GetString() ?? "" : "",
                    ContentIdHex = root.TryGetProperty("content_id_hex", out var cid) ? cid.GetString() ?? "" : "",
                    TotalRawSize = root.TryGetProperty("total_raw_size", out var trs) ? trs.GetUInt64() : 0UL,
                    EntryCount = root.TryGetProperty("entry_count", out var ec) ? (uint)ec.GetUInt64() : 0u,
                    ChunkCount = root.TryGetProperty("chunk_count", out var cc) ? (uint)cc.GetUInt64() : 0u,
                    ChunkRawSize = root.TryGetProperty("chunk_raw_size", out var crs) ? (uint)crs.GetUInt64() : 0u,
                    SymbolSize = root.TryGetProperty("symbol_size", out var ss) ? (uint)ss.GetUInt64() : 0u,
                    LegacyPeerFrames = root.TryGetProperty("legacy_peer_frames", out var lpf) ? (uint)lpf.GetUInt64() : 0u,
                    RootFrameBytes = root.TryGetProperty("root_frame_hex", out var rfh)
                        ? HexToBytes(rfh.GetString() ?? "") : Array.Empty<byte>(),
                };
                if (root.TryGetProperty("entries", out var entriesEl) &&
                    entriesEl.ValueKind == System.Text.Json.JsonValueKind.Array)
                {
                    var list = new List<ManifestEntryDto>(entriesEl.GetArrayLength());
                    foreach (var e in entriesEl.EnumerateArray())
                    {
                        var path = e.TryGetProperty("path", out var p) ? p.GetString() ?? "" : "";
                        list.Add(new ManifestEntryDto(
                            e.TryGetProperty("kind", out var k) ? k.GetInt32() : 1,
                            path,
                            // §7.2 save-time sanitized name (may equal path).
                            e.TryGetProperty("save_path", out var sp) ? sp.GetString() ?? path : path,
                            e.TryGetProperty("offset", out var o) ? o.GetUInt64() : 0UL,
                            e.TryGetProperty("size", out var s) ? s.GetUInt64() : 0UL));
                    }
                    snap.Entries = list;
                }
                _cachedSnapshot = snap;
                return snap;
            }
            catch (System.Text.Json.JsonException)
            {
                return _cachedSnapshot ?? new Snapshot();
            }
            finally
            {
                NativeBridge.FreeString(ptr);
            }
        }
    }

    private static byte[] HexToBytes(string s)
    {
        if (s.Length == 0 || s.Length % 2 != 0)
        {
            return Array.Empty<byte>();
        }
        var b = new byte[s.Length / 2];
        for (int i = 0; i < b.Length; i++)
        {
            b[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
        }
        return b;
    }

    public string FileName()
    {
        var snap = GetSnapshot();
        var nonDir = snap.Entries.Where(e => e.Kind != 3).ToList();
        if (nonDir.Count == 1) return nonDir[0].Path;
        if (nonDir.Count > 1) return $"多文件传输包 ({nonDir.Count} 项)";
        if (snap.EntryCount > 1) return $"多文件传输包 ({snap.EntryCount} 项)";
        return "文件传输";
    }
    public ulong FileSize() => GetSnapshot().TotalRawSize;
    public bool IsSegmented() => GetSnapshot().ChunkCount > 1;
    public uint SegmentIndex() => 0u;
    public uint SegmentCount() => Math.Max(GetSnapshot().ChunkCount, 1u);
    public ulong RootOriginalSize() => GetSnapshot().TotalRawSize;

    public byte[]? AssembleChunk(uint index)
    {
        lock (_gate)
        {
            if (!_initialized) return null;
            int ok = NativeBridge.ReceiverAssembleChunk(_handle, index, out IntPtr buf, out nuint len);
            if (ok == 0 || buf == IntPtr.Zero || len == 0) return null;
            try
            {
                byte[] data = new byte[(int)len];
                Marshal.Copy(buf, data, 0, (int)len);
                return data;
            }
            finally
            {
                NativeBridge.BufferFree(buf, len);
            }
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

    /// <summary>
    /// AF2 carries no whole-stream CRC32 on the wire (integrity is BLAKE3
    /// per chunk / manifest), so this is always "unknown" — kept for the
    /// recovery pipeline's v1-shaped AssembledPayload contract.
    /// </summary>
    public ulong Crc32() => 0UL;

    /// <summary>See <see cref="Crc32"/> — always false under AF2.</summary>
    public bool Crc32Known() => false;

    /// <summary>
    /// Index of the chunk completed by the most recent ChunkReady frame, or -1.
    /// </summary>
    public int LastChunkIndex()
    {
        lock (_gate)
        {
            if (!_initialized || _handle == IntPtr.Zero) return -1;
            return NativeBridge.ReceiverLastChunkIndex(_handle);
        }
    }

    /// <summary>Release a persisted chunk from native memory (eviction).</summary>
    public bool ForgetChunk(uint index)
    {
        lock (_gate)
        {
            if (!_initialized || _handle == IntPtr.Zero) return false;
            return NativeBridge.ReceiverForgetChunk(_handle, index) != 0;
        }
    }

    /// <summary>
    /// Drain the chunk completed by the frame just ingested: hand it to
    /// <paramref name="sink"/> and evict it from native memory (bounded-memory
    /// ledger). Call on the ingest thread right after Ingest reported
    /// ChunkReady. The gate Monitor is reentrant, so the nested
    /// snapshot/chunk calls under the same gate are safe.
    /// </summary>
    public void DrainLastChunk(Action<int, int, byte[]> sink)
    {
        int index = LastChunkIndex();
        if (index < 0) return;
        byte[]? bytes = AssembleChunk((uint)index);
        if (bytes is null) return;
        int chunkRawSize = unchecked((int)GetSnapshot().ChunkRawSize);
        sink(index, chunkRawSize, bytes);
        ForgetChunk((uint)index);
    }

    /// <summary>This object's transmitted payload length.</summary>
    public ulong CompressedSize() => GetSnapshot().TotalRawSize;

    /// <summary>Whole decompressed original size.</summary>
    public ulong OriginalSize() => GetSnapshot().TotalRawSize;

    /// <summary>Transfer id as a lowercase hex string ("" before ROOT lock).</summary>
    public string SessionIdHex() => GetSnapshot().TransferIdHex;

    public void Destroy()
    {
        lock (_gate)
        {
        _destroyed = true;
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
