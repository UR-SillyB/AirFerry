using OpenCvSharp;
using ZXing;

namespace AirFerry.Windows.Scan;

/// <summary>
/// Bridges OpenCvSharp's <see cref="Mat"/> into ZXing.Net's
/// <see cref="LuminanceSource"/> abstraction. Equivalent to the Android side's
/// zero-copy <c>ImageView</c> over the CameraX Y plane — here we copy once into
/// a managed byte[] because ZXing.Net's <c>LuminanceSource</c> contract owns a
/// byte buffer, and OpenCvSharp's Mat may have row padding we must strip.
/// </summary>
/// <remarks>
/// <para>
/// OpenCV Mats for a camera frame are usually contiguous (no padding), but the
/// contract allows <c>step != width</c>; we handle both by copying row-by-row
/// when <see cref="Mat.Step"/> &gt; width, and with a single bulk copy when
/// they're equal (the common case).
/// </para>
/// <para>
/// The grayscale Mat passed in must be <c>CV_8UC1</c>. The caller (decode pool)
/// guarantees this since it called <c>CvtColor(BGR2GRAY)</c>.
/// </para>
/// </remarks>
public sealed class MatLuminanceSource : LuminanceSource
{
    public int Width { get; }
    public int Height { get; }

    /// <summary>Required by ZXing.Net: returns the luminance byte array.</summary>
    public override byte[] Matrix => luminances;

    /// <summary>
    /// Required by ZXing.Net: copies one row of luminance data into the provided
    /// buffer. The row index <paramref name="y"/> is 0-based.
    /// </summary>
    public override byte[] getRow(int y, byte[] row)
    {
        int start = y * Width;
        System.Array.Copy(luminances, start, row, 0, Width);
        return row;
    }

    /// <summary>
    /// Build a luminance source over a grayscale <paramref name="gray"/> Mat.
    /// The Mat's pixels are copied into the internal buffer immediately; the
    /// Mat itself is not retained.
    /// </summary>
    public MatLuminanceSource(Mat gray)
        : base(gray.Width * gray.Height)
    {
        if (gray.Type() != MatType.CV_8UC1)
        {
            throw new ArgumentException(
                $"Mat must be CV_8UC1 grayscale, got {gray.Type()}", nameof(gray));
        }
        Width = gray.Width;
        Height = gray.Height;
        CopyLuminance(gray);
    }

    /// <summary>Empty source (used only as a placeholder in error paths).</summary>
    public MatLuminanceSource(int width, int height)
        : base(width * height)
    {
        Width = width;
        Height = height;
    }

    /// <summary>
    /// Build a luminance source over an already-extracted compact grayscale
    /// buffer (as produced by <c>Mat.GetArray</c>). The buffer must be exactly
    /// <paramref name="width"/> * <paramref name="height"/> bytes with no
    /// stride padding. The buffer is copied into the source's internal storage.
    /// </summary>
    public MatLuminanceSource(byte[] pixels, int width, int height)
        : base(width * height)
    {
        Width = width;
        Height = height;
        Buffer.BlockCopy(pixels, 0, luminances, 0, width * height);
    }

    private void CopyLuminance(Mat gray)
    {
        int width = gray.Width;
        int height = gray.Height;
        long step = (long)gray.Step();
        if (step == width)
        {
            // Contiguous: single bulk copy. SAFETY: the Mat's data pointer is
            // valid for the duration of this call (Mat not disposed). We copy
            // exactly width*height bytes.
            unsafe
            {
                byte* src = (byte*)gray.Data.ToPointer();
                fixed (byte* dst = luminances)
                {
                    Buffer.MemoryCopy(src, dst, luminances.Length, width * height);
                }
            }
        }
        else
        {
            // Padded rows: copy each row skipping the stride tail.
            unsafe
            {
                byte* srcBase = (byte*)gray.Data.ToPointer();
                fixed (byte* dstBase = luminances)
                {
                    for (int y = 0; y < height; y++)
                    {
                        byte* srcRow = srcBase + y * step;
                        byte* dstRow = dstBase + y * width;
                        Buffer.MemoryCopy(srcRow, dstRow, width, width);
                    }
                }
            }
        }
    }

    // LuminanceSource subset we care about: the base class's
    // `luminances` byte[] is already populated by CopyLuminance. We don't need
    // rotate/crop overrides — ZXing.Net's TryHarder path calls
    // getRow()/getMatrix() on copies of the source, and the base class handles
    // those from the byte[]. Leaving the defaults in place matches how the
    // Android side lets ZXing-C++ handle rotation internally.
}
