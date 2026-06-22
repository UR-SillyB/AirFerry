using OpenCvSharp;
using ZXing;

namespace AirFerry.Windows.Scan;

/// <summary>
/// Bridges OpenCvSharp's <see cref="Mat"/> into ZXing.Net's
/// <see cref="LuminanceSource"/> abstraction. The Mat's pixels are copied into
/// our own byte buffer (ZXing.Net 0.16.x does not expose a base-class
/// <c>luminances</c> field), and the overridden <see cref="Matrix"/> /
/// <see cref="getRow"/> return from it.
/// </summary>
public sealed class MatLuminanceSource : LuminanceSource
{
    private readonly byte[] _luminances;
    private readonly int _width;
    private readonly int _height;
    public override int Width => _width;
    public override int Height => _height;
    public override byte[] Matrix => _luminances;

    /// <summary>
    /// Build from a grayscale Mat (CV_8UC1). Pixels are copied immediately;
    /// the Mat is not retained.
    /// </summary>
    public MatLuminanceSource(Mat gray)
        : base(gray.Width, gray.Height)
    {
        if (gray.Type() != MatType.CV_8UC1)
        {
            throw new ArgumentException(
                $"Mat must be CV_8UC1 grayscale, got {gray.Type()}", nameof(gray));
        }
        _width = gray.Width;
        _height = gray.Height;
        _luminances = new byte[_width * _height];
        CopyFromMat(gray);
    }

    /// <summary>
    /// Build from an already-extracted compact grayscale buffer
    /// (as produced by <c>Mat.GetArray</c>).
    /// </summary>
    public MatLuminanceSource(byte[] pixels, int width, int height)
        : base(width, height)
    {
        _width = width;
        _height = height;
        _luminances = new byte[width * height];
        Buffer.BlockCopy(pixels, 0, _luminances, 0, width * height);
    }

    /// <summary>Placeholder for error paths.</summary>
    public MatLuminanceSource(int width, int height)
        : base(width, height)
    {
        _width = width;
        _height = height;
        _luminances = new byte[width * height];
    }

    public override byte[] getRow(int y, byte[] row)
    {
        System.Array.Copy(_luminances, y * Width, row, 0, Width);
        return row;
    }

    private void CopyFromMat(Mat gray)
    {
        int w = Width, h = Height;
        long step = (long)gray.Step();
        if (step == w)
        {
            unsafe
            {
                byte* src = (byte*)gray.Data.ToPointer();
                fixed (byte* dst = _luminances)
                {
                    Buffer.MemoryCopy(src, dst, _luminances.Length, w * h);
                }
            }
        }
        else
        {
            unsafe
            {
                byte* srcBase = (byte*)gray.Data.ToPointer();
                fixed (byte* dstBase = _luminances)
                {
                    for (int y = 0; y < h; y++)
                    {
                        Buffer.MemoryCopy(srcBase + y * step, dstBase + y * w, w, w);
                    }
                }
            }
        }
    }
}
