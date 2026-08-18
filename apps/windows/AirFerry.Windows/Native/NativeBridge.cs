using System.Runtime.InteropServices;

namespace AirFerry.Windows.Native;

/// <summary>
/// P/Invoke declarations for the Rust <c>transfer_engine</c> C ABI
/// (<c>core/transfer-engine/src/cffi.rs</c>, compiled with <c>--features cffi</c>).
/// </summary>
/// <remarks>
/// <para>
/// This is the Windows equivalent of Android's <c>NativeBridge.kt</c>: a thin
/// static surface that loads <c>transfer_engine.dll</c> and forwards each call
/// to the matching <c>#[no_mangle] extern "C"</c> symbol. The handle returned
/// by <see cref="ReceiverCreate"/> is an opaque pointer the host owns; every
/// other function takes it as the first argument.
/// </para>
/// <para>
/// <b>Symbol names</b>: Rust exports snake_case <c>airferry_*</c> symbols (the
/// C ABI contract in <c>cffi.rs</c>). Unlike Android's JNI — where the JVM
/// resolves <c>Java_&lt;class&gt;_&lt;method&gt;</c> names automatically — the
/// .NET P/Invoke marshaler looks up the entry point by the managed method name
/// unless <see cref="DllImportAttribute.EntryPoint"/> is given. Every declaration
/// below therefore pins <c>EntryPoint</c> explicitly: dropping it would make the
/// first call throw <c>EntryPointNotFoundException</c> at runtime (the build and
/// the protocol-layer unit tests never touch native code, so they can't catch it).
/// </para>
/// <para>
/// <b>Thread safety</b>: the Rust <c>ReceiverSession</c> is <b>not</b>
/// thread-safe. All calls touching the same handle must be serialized by the
/// caller — the Windows scan pool mirrors Android's <c>ingestLock</c> (a single
/// fair lock wrapping batched ingest + assemble).
/// </para>
/// <para>
/// <b>Memory ownership</b>: <see cref="ReceiverAssemble"/> returns a buffer
/// allocated by Rust; the host MUST copy the bytes out and then call
/// <see cref="BufferFree"/>. The <c>*_IntoBuffer</c> functions write into a
/// host-owned buffer using a two-pass length protocol (pass a 0-capacity buffer
/// first to learn the required length, then re-call with a buffer of that
/// size) — see <see cref="ReceiverProgressJson"/>.
/// </para>
/// </remarks>
internal static class NativeBridge
{
    private const string LibName = "transfer_engine.dll";

    /// <summary>
    /// Error sentinel returned by <see cref="ReceiverIngest"/>: the low 32
    /// bits hold <c>received_symbols</c>, and <c>0xFFFFFFFF</c> there is
    /// unreachable for any real transfer. Mirrors
    /// <c>cffi.rs::INGEST_ERROR</c> and <c>jni.rs::INGEST_ERROR</c> exactly.
    /// </summary>
    public const ulong IngestError = 0xFFFF_FFFFuL << 32;

    // ─── lifecycle ────────────────────────────────────────────────────────

    /// <summary>
    /// Create a cache-only receiver. No object metadata is built yet — data
    /// frames are buffered until the first validated ROOT/META frame supplies
    /// the authoritative OTI. Split the 128-bit session id into low/high
    /// 64-bit halves (host order), matching the Rust contract.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_create")]
    public static extern IntPtr ReceiverCreate(ulong sidLo, ulong sidHi);

    /// <summary>
    /// Destroy a receiver. <see cref="IntPtr.Zero"/> is a no-op. After this
    /// returns the handle is invalid and must not be reused.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_destroy")]
    public static extern void ReceiverDestroy(IntPtr handle);

    // ─── hot path ────────────────────────────────────────────────────────

    /// <summary>
    /// Ingest one decoded QR payload and return a packed 64-bit status word.
    /// </summary>
    /// <remarks>
    /// Bit layout (all fields unsigned):
    /// <list type="bullet">
    /// <item>bit 0: <c>complete</c> (1 once the object is fully decoded)</item>
    /// <item>bit 1: <c>accepted</c> (1 if this frame contributed a new symbol)</item>
    /// <item>bits 8..23: <c>session_mismatch_streak</c> (0..=0xFFFF)</item>
    /// <item>bits 32..63: <c>received_symbols</c> (low 32 bits)</item>
    /// </list>
    /// Returns <see cref="IngestError"/> on a null handle or a frame that fails
    /// wire validation; the host treats this as "frame rejected, nothing to do".
    /// </remarks>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_ingest")]
    public static extern ulong ReceiverIngest(IntPtr handle, byte[] frameBytes, nuint frameLen);

    /// <summary>1 once fully decoded, 0 otherwise (incl. null handle).</summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_is_complete")]
    public static extern int ReceiverIsComplete(IntPtr handle);

    // ─── result retrieval ────────────────────────────────────────────────

    /// <summary>
    /// Reassemble the recovered file into a Rust-allocated buffer.
    /// </summary>
    /// <returns>1 on success (writes the buffer pointer into <paramref
    /// name="outBuf"/> and its byte length into <paramref name="outLen"/>);
    /// 0 if not yet complete / null handle / decode error. The caller MUST
    /// release the buffer with <see cref="BufferFree"/>.</returns>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_assemble")]
    public static extern int ReceiverAssemble(IntPtr handle, out IntPtr outBuf, out nuint outLen);

    /// <summary>
    /// Release a buffer returned by <see cref="ReceiverAssemble"/>. Passing
    /// <see cref="IntPtr.Zero"/> / 0 is a no-op. Never call this on a pointer
    /// the host allocated itself.
    /// </summary>
    /// <remarks>
    /// <para><b>Layout contract (UB if violated):</b> Rust frees the buffer via
    /// <c>Box::from_raw(slice::from_raw_parts_mut(ptr, len))</c>, so
    /// <paramref name="ptr"/> and <paramref name="len"/> MUST be the exact,
    /// still-owned pair returned by <see cref="ReceiverAssemble"/> — i.e. the
    /// same <c>nuint</c> length the assemble call wrote to the host's
    /// <c>outLen</c>. Passing a mismatched <paramref name="len"/> reconstructs
    /// the <c>Box&lt;[u8]&gt;</c> with the wrong layout and is undefined
    /// behavior (Rust's allocator deallocates with the wrong size/alignment).
    /// Always capture <paramref name="len"/> from the assemble call's out-param
    /// and pass it through unmodified.</para>
    /// </remarks>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_buffer_free")]
    public static extern void BufferFree(IntPtr ptr, nuint len);

    /// <summary>Reassemble chunk <paramref name="index"/> into a native buffer.</summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_assemble_chunk")]
    public static extern int ReceiverAssembleChunk(IntPtr handle, uint index, out IntPtr outBuf, out nuint outLen);

    /// <summary>
    /// Index of the chunk completed by the most recent ChunkReady frame, or -1.
    /// Persist it via <see cref="ReceiverAssembleChunk"/> and release it via
    /// <see cref="ReceiverForgetChunk"/> to keep native memory bounded by one
    /// chunk instead of the whole object.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_last_chunk_index")]
    public static extern int ReceiverLastChunkIndex(IntPtr handle);

    /// <summary>
    /// Release a persisted chunk from native memory (eviction). Returns 1 when
    /// the chunk was resident. Completion tracking is unaffected.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_forget_chunk")]
    public static extern int ReceiverForgetChunk(IntPtr handle, uint index);

    /// <summary>
    /// Decompress a byte buffer by tag (0=None,1=Zstd,2=Xz), bounded by
    /// <paramref name="maxOutput"/> bytes. Returns 1 on success (buffer freed
    /// with <see cref="BufferFree"/>), 0 on failure.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_decompress_bytes")]
    public static extern int DecompressBytes(
        byte[] data,
        nuint dataLen,
        byte compression,
        ulong maxOutput,
        out IntPtr outBuf,
        out nuint outLen);

    /// <summary>
    /// Stream-decompress the concatenated compressed stream at
    /// <paramref name="inputPath"/> to <paramref name="outputPath"/> (zstd/xz
    /// streaming decoder) while computing CRC32 + SHA-256 incrementally —
    /// neither input nor output is held wholly in memory, so very large files
    /// are recoverable in bounded RAM. Returns 1 only when the decompressed
    /// size, CRC32 (when <paramref name="crcKnown"/>) and SHA-256
    /// (<paramref name="expectedShaHex"/>, lowercase hex) all match; on any
    /// failure the partial output file is removed.
    /// </summary>
    /// <remarks>
    /// <para><b>UTF-8 path encoding:</b> the three path/hex string params are
    /// passed as NUL-terminated UTF-8 <see cref="byte"/>[] (built with
    /// <c>Encoding.UTF8.GetBytes(s + "\0")</c>), NOT <c>[MarshalAs(LPStr)]
    /// string</c>. The Rust side (<c>cffi.rs::cstr</c>) reads them via
    /// <c>CStr::from_ptr().to_bytes()</c> + <c>from_utf8_lossy</c>, i.e. it
    /// assumes UTF-8. <c>LPStr</c> marshals as ANSI (system codepage = GBK on
    /// zh-CN), which corrupts any non-ASCII path — and the store root is
    /// <c>&lt;MyDocuments&gt;\AirFerry\store\...</c>, which on a localized
    /// Windows is under <c>文档</c> or a non-ASCII username. Using UTF-8
    /// <see cref="byte"/>[] matches the existing <see cref="ReceiverIngest"/>
    /// / <see cref="DecompressBytes"/> <c>byte[]</c> convention and the Android
    /// JNI bridge (which also passes UTF-8).</para>
    /// </remarks>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_decompress_stream_to_file")]
    public static extern int DecompressStreamToFile(
        byte[] inputPathUtf8,
        byte[] outputPathUtf8,
        byte compression,
        ulong maxOutput,
        ulong expectedSize,
        uint expectedCrc,
        [MarshalAs(UnmanagedType.I1)] bool crcKnown,
        byte[] expectedShaHexUtf8);

    /// <summary>
    /// Write the NUL-terminated progress JSON into <paramref name="outBuf"/>.
    /// Two-pass protocol: pass a 0-capacity (or too-small) buffer to learn the
    /// required length (incl. NUL), then call again with a buffer of that size.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_progress_json")]
    public static extern nuint ReceiverProgressJson(IntPtr handle, byte[]? outBuf, nuint cap);

    /// <summary>
    /// Single-JSON receiver snapshot (<c>ReceiverSnapshotV2</c>): every
    /// recovered-transfer field the AF2 schema exposes (name/sizes/CRC/codec,
    /// session id, manifest/chunk metadata) in ONE atomic call, replacing the
    /// former 16 per-field getters. Returns a Rust-allocated NUL-terminated
    /// UTF-8 string — free it with <see cref="FreeString"/>,
    /// never with your own <c>free</c>.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_snapshot_json")]
    public static extern IntPtr ReceiverSnapshotJson(IntPtr handle);

    /// <summary>Free a string returned by <see cref="ReceiverSnapshotJson"/>.</summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_free_string")]
    public static extern void FreeString(IntPtr ptr);

    /// <summary>Verify a staged raw chunk against the ROOT-bound Manifest table (§11).</summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_verify_chunk")]
    public static extern int ReceiverVerifyChunk(IntPtr handle, uint index, byte[] rawBytes, nuint rawLen);

    /// <summary>Run §13 ⑧⑨ integrity chain over the reassembled canonical stream.</summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_verify_final_stream")]
    public static extern int ReceiverVerifyFinalStream(IntPtr handle, byte[] streamBytes, nuint streamLen);

    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_final_verify_begin")]
    public static extern int ReceiverFinalVerifyBegin(IntPtr handle);

    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_final_verify_feed")]
    public static extern int ReceiverFinalVerifyFeed(IntPtr handle, byte[] streamBytes, nuint streamLen);

    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_final_verify_finish")]
    public static extern int ReceiverFinalVerifyFinish(IntPtr handle);

    /// <summary>Restore receiver from stored ROOT frame bytes + completed chunk indices (§12 resume).</summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_resume")]
    public static extern int ReceiverResume(IntPtr handle, byte[] rootFrameBytes, nuint rootLen, uint[] completedIndices, nuint completedLen);

    /// <summary>
    /// Evict one chunk from both ledgers after a spill re-verification failure
    /// (§11/§12): the sender's next epoch re-supplies it.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_receiver_invalidate_chunk")]
    public static extern int ReceiverInvalidateChunk(IntPtr handle, uint index);

    /// <summary>Report the native ABI / capability version of the loaded DLL.</summary>
    /// <remarks>
    /// Mirrors the Android <c>NativeBridge.nativeAbiVersion()</c> handshake:
    /// the host must verify <c>NativeAbiVersion() &gt;= NativeAbiVersion2</c>
    /// before using the receiver, so a stale <c>transfer_engine.dll</c>
    /// (missing <c>airferry_receiver_snapshot_json</c>) fails up front with a
    /// clear message instead of an <see cref="EntryPointNotFoundException"/>
    /// on the first decoded QR frame.
    /// </remarks>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl,
        EntryPoint = "airferry_native_abi_version")]
    public static extern uint NativeAbiVersion();

    /// <summary>Snapshot ABI: the 16 per-field getters were folded into one JSON.</summary>
    public const uint NativeAbiVersion2 = 2;
    /// <summary>Bounded-memory incremental final-verification ABI.</summary>
    public const uint NativeAbiVersion3 = 3;
}
