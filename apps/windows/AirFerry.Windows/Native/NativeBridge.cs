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
    /// frames are buffered until the first validated descriptor frame supplies
    /// the authoritative OTI. Split the 128-bit session id into low/high
    /// 64-bit halves (host order), matching the Rust contract.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr ReceiverCreate(ulong sidLo, ulong sidHi);

    /// <summary>
    /// Destroy a receiver. <see cref="IntPtr.Zero"/> is a no-op. After this
    /// returns the handle is invalid and must not be reused.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl)]
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
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl)]
    public static extern ulong ReceiverIngest(IntPtr handle, byte[] frameBytes, nuint frameLen);

    /// <summary>1 once fully decoded, 0 otherwise (incl. null handle).</summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int ReceiverIsComplete(IntPtr handle);

    // ─── result retrieval ────────────────────────────────────────────────

    /// <summary>
    /// Reassemble the recovered file into a Rust-allocated buffer.
    /// </summary>
    /// <returns>1 on success (writes the buffer pointer into <paramref
    /// name="outBuf"/> and its byte length into <paramref name="outLen"/>);
    /// 0 if not yet complete / null handle / decode error. The caller MUST
    /// release the buffer with <see cref="BufferFree"/>.</returns>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int ReceiverAssemble(IntPtr handle, out IntPtr outBuf, out nuint outLen);

    /// <summary>
    /// Release a buffer returned by <see cref="ReceiverAssemble"/>. Passing
    /// <see cref="IntPtr.Zero"/> / 0 is a no-op. Never call this on a pointer
    /// the host allocated itself.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl)]
    public static extern void BufferFree(IntPtr ptr, nuint len);

    /// <summary>
    /// Write the NUL-terminated progress JSON into <paramref name="out"/>.
    /// Two-pass protocol: pass a 0-capacity (or too-small) buffer to learn the
    /// required length (incl. NUL), then call again with a buffer of that size.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl)]
    public static extern nuint ReceiverProgressJson(IntPtr handle, byte[]? outBuf, nuint cap);

    /// <summary>
    /// Write the recovered filename (UTF-8 + NUL) using the same two-pass
    /// protocol as <see cref="ReceiverProgressJson"/>.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl)]
    public static extern nuint ReceiverFileName(IntPtr handle, byte[]? outBuf, nuint cap);

    /// <summary>Original file size in bytes (0 if unknown / null handle).</summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl)]
    public static extern ulong ReceiverFileSize(IntPtr handle);

    /// <summary>
    /// CRC32 of the original file as a <see cref="ulong"/> (so the full
    /// unsigned 32-bit range survives; <c>0xDEADBEEF</c> would look negative
    /// as a signed int). 0 if unknown.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl)]
    public static extern ulong ReceiverCrc32(IntPtr handle);

    /// <summary>
    /// 1 if the descriptor supplied a real CRC32 (so the host should verify
    /// it); 0 if unknown and the CRC MUST NOT be compared. CRC32 can
    /// legitimately be 0, so do not test <c>Crc32() == 0</c>.
    /// </summary>
    [DllImport(LibName, CallingConvention = CallingConvention.Cdecl)]
    public static extern int ReceiverCrc32Known(IntPtr handle);
}
