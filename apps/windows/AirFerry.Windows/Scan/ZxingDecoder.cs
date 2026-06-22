using ZXing;
using ZXing.Common;

namespace AirFerry.Windows.Scan;

/// <summary>
/// QR decoder wrapping ZXing.Net — the Windows counterpart of Android's
/// ZXing-C++ bridge (<c>scan_jni.cpp::decodeInView</c>). The reader options
/// (<c>QR_CODE</c> only, <c>TryHarder</c>, <c>TryInvert</c>) are intentionally
/// identical so both hosts behave the same on screen-captured QR codes.
/// </summary>
/// <remarks>
/// <para>
/// <b>TryHarder</b> is essential: screen QRs are high-contrast but webcam/capture-
/// card frames arrive blurred, perspective-warped, or partially cropped by the
/// quiet-zone margin. <b>TryInvert</b> covers the case where a dark-background
/// QR inverts the usual light-on-dark polarity.
/// </para>
/// <para>
/// The luminance source (<see cref="MatLuminanceSource"/>) feeds directly off
/// the extracted grayscale pixel buffer — no intermediate format conversion —
/// matching the zero-copy intent of Android's <c>ImageView</c> over the Y plane.
/// </para>
/// <para>
/// <b>Threading</b>: the <see cref="BarcodeReader"/> is documented as not
/// thread-safe, so each worker in <see cref="QrDecodePool"/> owns its own
/// instance via <see cref="CreateReader"/>.
/// </para>
/// </remarks>
public static class ZxingDecoder
{
    /// <summary>
    /// Build a per-worker reader. The options mirror scan_jni.cpp exactly:
    /// QR-only format, TryHarder, TryInvert. A fresh reader per worker avoids
    /// the shared-state threading hazard.
    /// </summary>
    public static BarcodeReader CreateReader()
    {
        var reader = new BarcodeReader(CreateLuminanceSource)
        {
            AutoRotate = true,
            Options = new DecodingOptions
            {
                PossibleFormats = [BarcodeFormat.QR_CODE],
                TryHarder = true,
                TryInverted = true,
            },
        };
        return reader;
    }

    /// <summary>
    /// Decode a single QR (the first valid one) from a luminance source.
    /// Returns the raw payload bytes, or null if no QR is found. Mirrors
    /// <c>scan_jni.cpp::decodeInView</c> + ZXing's <c>ReadBarcode</c> (singular).
    /// </summary>
    public static byte[]? Decode(BarcodeReader reader, MatLuminanceSource source)
    {
        Result? result = reader.Decode(source);
        return ResultToBytes(result);
    }

    /// <summary>
    /// Decode all QR codes in a frame. Mirrors <c>scan_jni.cpp::decodeInViewMultiFull</c>
    /// + ZXing's <c>ReadBarcodes</c> (plural). Yields ~N symbols per tick when
    /// the sender tiles N codes per frame. Returns an empty list (not null) on
    /// miss.
    /// </summary>
    public static List<byte[]> DecodeMultiple(BarcodeReader reader, MatLuminanceSource source)
    {
        Result[] results = reader.DecodeMultiple(source);
        if (results is null || results.Length == 0)
        {
            return [];
        }
        var outList = new List<byte[]>(results.Length);
        foreach (Result r in results)
        {
            byte[]? bytes = ResultToBytes(r);
            if (bytes is not null)
            {
                outList.Add(bytes);
            }
        }
        return outList;
    }

    /// <summary>
    /// Factory passed to <see cref="BarcodeReader"/>; ZXing calls it with the
    /// <see cref="MatLuminanceSource"/> we passed in to <c>Decode</c>, then
    /// uses it for cropping/rotation. We just unwrap and return.
    /// </summary>
    private static LuminanceSource CreateLuminanceSource(object rawSource)
    {
        if (rawSource is MatLuminanceSource src)
        {
            return src;
        }
        // Unsupported source type — return an empty source rather than throw.
        return new MatLuminanceSource(1, 1);
    }

    /// <summary>
    /// Pull the raw byte payload from a Result. Uses <see cref="Result.RawBytes"/>
    /// — the QR data codewords after error-correction, <b>before</b> any
    /// character-set (ECI) decoding — so binary payloads (AirFerry frame
    /// headers contain magic bytes, big-endian ints, CRCs that are NOT valid
    /// UTF-8) round-trip byte-for-byte. The Android C++ path gets this for free
    /// (ZXing-C++ returns <c>ByteArray</c>); ZXing.Net routes through a string,
    /// so we bypass the string entirely.
    /// </summary>
    private static byte[]? ResultToBytes(Result? result)
    {
        if (result is null)
        {
            return null;
        }
        // RawBytes is the authoritative binary payload of the QR.
        byte[]? raw = result.RawBytes;
        if (raw is not null && raw.Length > 0)
        {
            return raw;
        }
        // Fallback: if RawBytes wasn't populated (rare, only for some formats),
        // use Latin1 to preserve bytes 0x00..0xFF 1:1 from the text path.
        if (!string.IsNullOrEmpty(result.Text))
        {
            return System.Text.Encoding.Latin1.GetBytes(result.Text);
        }
        return null;
    }
}
